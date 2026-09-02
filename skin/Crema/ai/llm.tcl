# Crema standalone LLM client — talks directly to an AI provider from the
# tablet (no Mac server). Ports the advice prompt into Tcl, calls the
# provider over HTTPS with the user's own API key, and parses the JSON advice.
#
# Providers:
#   anthropic  -> POST {base}/v1/messages           (x-api-key + anthropic-version)
#   openai     -> POST {base}/v1/chat/completions    (Authorization: Bearer)
#   google     -> POST {base}/chat/completions       (Gemini's OpenAI-compatible
#                 endpoint; base already ends /v1beta/openai; free tier available)
#   compatible -> {base}/v1/chat/completions, custom base URL
#                 (OpenRouter, Groq, DeepSeek, Ollama, LM Studio, ...)
#
# Settings (::crema_settings):
#   ai_provider   anthropic | openai | google | compatible
#   ai_api_key    the user's key
#   ai_model      model id (e.g. claude-haiku-4-5, gpt-4o-mini, ...); blank uses
#                 the cheap-but-capable per-provider default below
#   ai_base_url   optional override (compatible), else provider default

package require http
package require json
catch { package require tls }

namespace eval ::crema::llm {
	variable max_curve_points 60

	# HTTPS transport. We add an SNI -servername (the provider hosts sit behind
	# CDNs that need it) and let tls negotiate the protocol version — the same
	# setup de1app's own visualizer/log-upload plugins use, which is proven on
	# the tablet's tls build. (An earlier version passed -tls1.3, which the
	# tablet's older tls rejects with "wrong # args: should be tls::socket ...".)
	proc _tls_socket {args} {
		set host [lindex $args end-1]
		# Force IPv4. Many tablet networks hand out an IPv6 address that doesn't
		# actually route; Tcl then prefers the host's AAAA record and hangs on
		# the dead IPv6 path until timeout. Binding a local IPv4 (0.0.0.0) makes
		# the socket IPv4-only, so only the reachable A record is tried.
		if {[catch { set s [::tls::socket -servername $host -myaddr 0.0.0.0 {*}$args] } e]} {
			# fall back if this tls build rejects -myaddr
			set s [::tls::socket -servername $host {*}$args]
		}
		return $s
	}
	proc _register_tls {} {
		catch { ::http::register https 443 ::crema::llm::_tls_socket }
	}

	proc provider {} { return [ifexists ::crema_settings(ai_provider) anthropic] }
	proc api_key  {} { return [ifexists ::crema_settings(ai_api_key) ""] }

	proc model {} {
		set m [ifexists ::crema_settings(ai_model) ""]
		if {$m ne ""} { return $m }
		switch -- [provider] {
			openai     { return "gpt-4o-mini" }
			google     { return "gemini-flash-lite-latest" }
			compatible { return "llama3.1" }
			server     { return "opus" }
			default    { return "claude-haiku-4-5" }
		}
	}

	proc base_url {} {
		set b [ifexists ::crema_settings(ai_base_url) ""]
		if {$b ne ""} { return [string trimright $b /] }
		switch -- [provider] {
			openai     { return "https://api.openai.com" }
			google     { return "https://generativelanguage.googleapis.com/v1beta/openai" }
			compatible { return "http://localhost:11434" }
			server     { return "http://localhost:8877" }
			default    { return "https://api.anthropic.com" }
		}
	}

	# full chat endpoint URL (base already carries any version segment)
	proc endpoint {} {
		set b [base_url]
		switch -- [provider] {
			anthropic { return "$b/v1/messages" }
			google    { return "$b/chat/completions" }
			default   { return "$b/v1/chat/completions" }
		}
	}

	proc configured {} {
		return [expr {[provider] in {compatible server} || [api_key] ne ""}]
	}

	# ---- LAN auto-discovery of the Mac advice server ----------------------
	# The Mac-server's IP changes when DHCP renews, breaking the configured
	# ai_base_url. When we can't reach it, scan the local /24 for the server:
	# a lightweight RAW async TCP connect to :8877 on every host (proven fast -
	# an open port answers in tens of ms; HTTP-scanning 254 hosts hangs), then
	# an HTTP /health on the first open port to confirm it's actually OUR server
	# (signature contains "claude") before re-pointing ai_base_url at it.
	variable disc
	array set disc {done 1}

	# the tablet's own LAN IP, from the source address the OS picks to route out.
	# The async socket never has to CONNECT - creating it binds a local endpoint
	# for the route, which -sockname reports - so this works even with no internet.
	proc _local_ip {} {
		set ip ""
		catch {
			set s [socket -async 8.8.8.8 53]
			for {set i 0} {$i < 25 && $ip eq ""} {incr i} {
				set cand [lindex [fconfigure $s -sockname] 0]
				if {[regexp {^\d+\.\d+\.\d+\.\d+$} $cand] && $cand ne "0.0.0.0"} { set ip $cand }
				if {$ip eq ""} { after 20 ; update idletasks }
			}
			catch { close $s }
		}
		return $ip
	}

	proc _disc_subnet {} {
		# scan the network the TABLET is actually on, not the (possibly stale or
		# default) configured server URL - that mismatch is why discovery used to
		# fail after the Mac's IP changed or on a different subnet.
		if {[regexp {(\d+\.\d+\.\d+)\.\d+} [_local_ip] -> p]} { return $p }
		foreach key {ai_base_url server_url} {
			set v [ifexists ::crema_settings($key) ""]
			if {[regexp {(\d+\.\d+\.\d+)\.\d+} $v -> p]} { return $p }
		}
		return ""
	}

	# discover_server {cb}: BOUNDED async raw-TCP scan of the /24 for :8877.
	# Opening all 254 sockets at once overwhelmed the tablet (unreliable writable
	# events + fd exhaustion), so we keep only ~30 probes in flight and refill as
	# they resolve. cb is called once with the discovered base url, or "".
	proc discover_server {cb} {
		variable disc
		array unset disc
		set prefix [_disc_subnet]
		catch { msg -INFO "crema: discover_server start, subnet=$prefix" }
		if {$prefix eq ""} { array set disc {done 1}; after 0 [list {*}$cb ""] ; return }
		array set disc [list done 0 cb $cb prefix $prefix next 1 active 0 found "" conc 30 opened 0 tmos 0]
		after 14000 ::crema::llm::_disc_giveup
		_disc_pump
	}

	proc _disc_pump {} {
		variable disc
		if {$disc(done)} return
		while {$disc(active) < $disc(conc) && $disc(next) <= 254} {
			set host "$disc(prefix).$disc(next)"
			incr disc(next)
			if {[catch { set s [socket -async $host 8877] }]} { continue }
			set disc(host,$s) $host
			incr disc(active)
			incr disc(opened)
			fileevent $s writable [list ::crema::llm::_disc_conn $s]
			after 900 [list ::crema::llm::_disc_timeout $s]
		}
		if {$disc(active) == 0 && $disc(next) > 254} { _disc_giveup }
	}

	proc _disc_release {s} {
		variable disc
		catch { fileevent $s writable {} }
		catch { close $s }
		if {[info exists disc(host,$s)]} { unset disc(host,$s); if {$disc(active) > 0} { incr disc(active) -1 } }
	}

	proc _disc_conn {s} {
		variable disc
		if {![info exists disc(host,$s)]} return
		set host $disc(host,$s)
		set err "gone"
		catch { set err [fconfigure $s -error] }
		_disc_release $s
		if {$disc(done)} return
		if {$err eq "" && $disc(found) eq ""} {
			set disc(found) $host
			catch { msg -INFO "crema: discover found open :8877 at $host, verifying" }
			_disc_verify $host
			return
		}
		_disc_pump
	}

	proc _disc_timeout {s} {
		variable disc
		if {![info exists disc(host,$s)]} return
		catch { incr disc(tmos) }
		_disc_release $s
		if {$disc(done)} return
		_disc_pump
	}

	# confirm an open :8877 is really our advisor before adopting it
	proc _disc_verify {host} {
		variable disc
		if {$disc(done)} return
		catch {
			::http::geturl "http://$host:8877/health" -timeout 3000 \
				-command [list ::crema::llm::_disc_verified $host]
		}
	}

	proc _disc_verified {host tok} {
		variable disc
		set ok 0
		catch { if {[::http::ncode $tok] == 200 && [string match *claude* [::http::data $tok]]} { set ok 1 } }
		catch { ::http::cleanup $tok }
		if {$disc(done)} return
		if {$ok} {
			set disc(done) 1
			_disc_cleanup
			set url "http://$host:8877"
			set ::crema_settings(ai_base_url) $url
			set ::crema_settings(server_url)  $url
			catch { ::crema::save_settings }
			catch { msg -INFO "crema: discovered advice server at $url" }
			catch { {*}$disc(cb) $url }
		} else {
			# open port but not our server - keep scanning
			set disc(found) ""
			_disc_pump
		}
	}

	proc _disc_giveup {} {
		variable disc
		if {![info exists disc(done)] || $disc(done)} return
		set disc(done) 1
		catch { msg -INFO "crema: discover gave up - opened=$disc(opened) timeouts=$disc(tmos) next=$disc(next) active=$disc(active) found='$disc(found)'" }
		_disc_cleanup
		catch { {*}$disc(cb) "" }
	}

	proc _disc_cleanup {} {
		variable disc
		foreach k [array names disc host,*] {
			set s [string range $k 5 end]
			catch { fileevent $s writable {} }
			catch { close $s }
			unset disc($k)
		}
		set disc(active) 0
	}

	# Turn a provider HTTP error into a human sentence. Anthropic, OpenAI and
	# Gemini all return {"error":{"message":"..."}} - surface that instead of a
	# raw JSON blob so the advice page can say what actually went wrong.
	proc http_error_message {ncode data} {
		# empty/zero code = no HTTP response at all - a timeout or dropped connection
		# (usually the AI took too long to answer), NOT the server rejecting the call
		if {$ncode eq "" || $ncode == 0} {
			if {[provider] eq "server"} {
				return "The Mac server didn't answer in time. It's usually slow the first time or when Claude is busy - tap Try again. (Tip: if it keeps timing out, prune old Claude transcripts to speed it up.)"
			}
			return "The AI didn't answer in time - tap Try again."
		}
		set msg ""
		catch {
			set ed [::json::json2dict $data]
			if {[dict exists $ed error message]} { set msg [dict get $ed error message] }
		}
		if {$msg eq ""} { set msg [string trim [string range $data 0 180]] }
		set name [string totitle [provider]]
		if {$ncode == 401 || $ncode == 403} {
			return "$name rejected the API key (HTTP $ncode). Check it in Settings > AI setup.\n$msg"
		}
		return "$name error (HTTP $ncode): $msg"
	}

	# ---- JSON string helpers ---------------------------------------------
	proc jesc {s} {
		return [string map [list "\\" "\\\\" "\"" "\\\"" "\n" "\\n" "\r" "" "\t" "\\t"] $s]
	}
	proc jstr {s} { return "\"[jesc $s]\"" }

	proc jnum_or_null {v} {
		if {[string is double -strict $v]} { return $v }
		return "null"
	}

	# JSON array of numbers from a Tcl list (nulls for non-numbers)
	proc jnums {vals} {
		set out {}
		foreach v $vals {
			if {[string is double -strict $v]} { lappend out $v } else { lappend out null }
		}
		return "\[[join $out ,]\]"
	}

	proc downsample {vals {limit 0}} {
		variable max_curve_points
		if {$limit == 0} { set limit $max_curve_points }
		set n [llength $vals]
		if {$n <= $limit} { return $vals }
		set step [expr {double($n) / $limit}]
		set out {}
		for {set i 0} {$i < $limit} {incr i} {
			lappend out [lindex $vals [expr {int($i * $step)}]]
		}
		return $out
	}

	# ---- HTTPS request ----------------------------------------------------
	proc post_json {url headers body} {
		if {[string match https://* $url]} {
			_register_tls
		}
		set tok [::http::geturl $url -method POST -type "application/json" \
			-headers $headers -query [encoding convertto utf-8 $body] -timeout 90000]
		set ncode [::http::ncode $tok]
		set data [encoding convertfrom utf-8 [::http::data $tok]]
		::http::cleanup $tok
		if {$ncode < 200 || $ncode >= 300} {
			error "provider returned HTTP $ncode: [string range $data 0 300]"
		}
		return $data
	}

	# chat/completions request body. OpenAI reasoning models (o-series / gpt-5)
	# reject max_tokens - they need max_completion_tokens plus big headroom for
	# the hidden reasoning tokens; ordinary chat models use max_tokens.
	proc chat_body {mdl body_prompt} {
		if {[regexp {^(o[0-9]|gpt-5)} $mdl]} {
			# low reasoning effort: dial-in doesn't need deep deliberation, and it
			# roughly halves latency while keeping the smart, holistic reasoning.
			return "\{\"model\":[jstr $mdl],\"max_completion_tokens\":25000,\"reasoning_effort\":\"low\",\"messages\":\[\{\"role\":\"user\",\"content\":$body_prompt\}\]\}"
		}
		return "\{\"model\":[jstr $mdl],\"max_tokens\":8000,\"messages\":\[\{\"role\":\"user\",\"content\":$body_prompt\}\]\}"
	}

	# ---- provider adapters: prompt -> reply text --------------------------
	proc call_provider {prompt} {
		set key [api_key]
		set mdl [model]
		set url [endpoint]
		set body_prompt [jstr $prompt]
		if {[provider] eq "anthropic"} {
			set headers [list x-api-key $key anthropic-version "2023-06-01"]
			set body "\{\"model\":[jstr $mdl],\"max_tokens\":8000,\"messages\":\[\{\"role\":\"user\",\"content\":$body_prompt\}\]\}"
			set resp [post_json $url $headers $body]
			set d [::json::json2dict $resp]
			set text ""
			catch {
				foreach block [dict get $d content] {
					if {[dict get $block type] eq "text"} { append text [dict get $block text] }
				}
			}
			return $text
		} else {
			# openai / google / compatible — all speak chat/completions
			set headers [list]
			if {$key ne ""} { lappend headers Authorization "Bearer $key" }
			set body [chat_body $mdl $body_prompt]
			set resp [post_json $url $headers $body]
			set d [::json::json2dict $resp]
			return [dict get [dict get [lindex [dict get $d choices] 0] message] content]
		}
	}

	# ---- extract the JSON advice object from the reply text ---------------
	proc extract_json {text} {
		set start [string first "\{" $text]
		if {$start < 0} { error "no JSON object in model reply: [string range $text 0 200]" }
		set depth 0
		set instr 0
		set esc 0
		set len [string length $text]
		for {set i $start} {$i < $len} {incr i} {
			set ch [string index $text $i]
			if {$instr} {
				if {$esc} { set esc 0 } elseif {$ch eq "\\"} { set esc 1 } elseif {$ch eq "\""} { set instr 0 }
				continue
			}
			if {$ch eq "\""} { set instr 1 } elseif {$ch eq "\{"} { incr depth } elseif {$ch eq "\}"} {
				incr depth -1
				if {$depth == 0} { return [::json::json2dict [string range $text $start $i]] }
			}
		}
		error "unbalanced JSON in model reply"
	}

	# ---- public entry (sync): build prompt, call, parse advice dict -------
	# Blocks the event loop - use only for tests. Production uses get_advice_async.
	proc get_advice {payload previous {rebuttal ""}} {
		set prompt [::crema::llm::build_prompt $payload $previous $rebuttal]
		set text [call_provider $prompt]
		return [extract_json $text]
	}

	# ---- async entry: cb is called as {cb ok <advice-dict>} or
	#      {cb error <message>}. Never blocks the UI.
	proc get_advice_async {payload previous cb {rebuttal ""} {starter 0}} {
		if {[catch {
			if {$starter} {
				set prompt [::crema::llm::build_starter_prompt $payload]
			} else {
				set prompt [::crema::llm::build_prompt $payload $previous $rebuttal]
			}
			set key [api_key]
			set mdl [model]
			set url [endpoint]
			set bp [jstr $prompt]
			set prov [provider]
			if {$prov eq "anthropic"} {
				set headers [list x-api-key $key anthropic-version "2023-06-01"]
				set body "\{\"model\":[jstr $mdl],\"max_tokens\":8000,\"messages\":\[\{\"role\":\"user\",\"content\":$bp\}\]\}"
			} else {
				set headers [list]
				if {$key ne ""} { lappend headers Authorization "Bearer $key" }
				set body [chat_body $mdl $bp]
			}
			if {[string match https://* $url]} {
				_register_tls
			}
			::http::geturl $url -method POST -type "application/json" -headers $headers \
				-query [encoding convertto utf-8 $body] -timeout 90000 \
				-command [list ::crema::llm::_async_done $prov $cb]
		} err]} {
			after 0 [list {*}$cb error $err]
		}
	}

	proc _async_done {prov cb tok} {
		if {[catch {
			set ncode [::http::ncode $tok]
			set data [encoding convertfrom utf-8 [::http::data $tok]]
			::http::cleanup $tok
			if {$ncode < 200 || $ncode >= 300} {
				error [http_error_message $ncode $data]
			}
			set d [::json::json2dict $data]
			if {$prov eq "anthropic"} {
				set text ""
				foreach block [dict get $d content] {
					if {[dict get $block type] eq "text"} { append text [dict get $block text] }
				}
			} else {
				set text [dict get [dict get [lindex [dict get $d choices] 0] message] content]
			}
			set advice [extract_json $text]
		} err]} {
			catch { ::http::cleanup $tok }
			after 0 [list {*}$cb error $err]
			return
		}
		after 0 [list {*}$cb ok $advice]
	}

	# Lightweight connectivity/auth check for the setup wizard - fires ONE tiny
	# request (no shot, ~1-2s) and reports whether the config actually works.
	# cb is called as {cb ok ""} or {cb error "<human message>"}.
	proc test_connection {cb} {
		if {[provider] eq "server" || [ifexists ::crema_settings(ai_mode) standalone] eq "server"} {
			set base [string trimright [ifexists ::crema_settings(ai_base_url) ""] /]
			if {$base eq ""} { set base [string trimright [ifexists ::crema_settings(server_url) ""] /] }
			if {$base eq ""} { after 0 [list {*}$cb error "No server URL set."] ; return }
			if {[string match https://* $base]} { _register_tls }
			if {[catch {
				::http::geturl "$base/health" -timeout 6000 \
					-command [list ::crema::llm::_test_health $cb]
			}]} { after 0 [list {*}$cb error "Can't reach $base"] }
			return
		}
		if {[catch {
			set key [api_key] ; set mdl [model] ; set url [endpoint] ; set prov [provider]
			if {$prov ne "compatible" && $key eq ""} {
				after 0 [list {*}$cb error "Enter your API key first."] ; return
			}
			set bp [jstr "hi"]
			if {$prov eq "anthropic"} {
				set headers [list x-api-key $key anthropic-version "2023-06-01"]
			} else {
				set headers [list]
				if {$key ne ""} { lappend headers Authorization "Bearer $key" }
			}
			set body "\{\"model\":[jstr $mdl],\"max_tokens\":1,\"messages\":\[\{\"role\":\"user\",\"content\":$bp\}\]\}"
			if {[string match https://* $url]} { _register_tls }
			::http::geturl $url -method POST -type "application/json" -headers $headers \
				-query [encoding convertto utf-8 $body] -timeout 15000 \
				-command [list ::crema::llm::_test_done $cb]
		} err]} { after 0 [list {*}$cb error $err] }
	}
	proc _test_health {cb tok} {
		set ok 0 ; set msg "No response from server"
		catch {
			set code [::http::ncode $tok]
			if {$code == 200} { set ok 1 } else { set msg "Server replied $code" }
		}
		catch { ::http::cleanup $tok }
		after 0 [list {*}$cb [expr {$ok ? "ok" : "error"}] [expr {$ok ? "" : $msg}]]
	}
	proc _test_done {cb tok} {
		set ok 0 ; set msg "Request failed"
		if {[catch {
			set code [::http::ncode $tok]
			set data [encoding convertfrom utf-8 [::http::data $tok]]
			::http::cleanup $tok
			if {$code >= 200 && $code < 300} { set ok 1 } else { set msg [http_error_message $code $data] }
		} err]} { catch { ::http::cleanup $tok } ; set msg $err }
		after 0 [list {*}$cb [expr {$ok ? "ok" : "error"}] [expr {$ok ? "" : $msg}]]
	}
}

# The advice JSON schema, shared by the per-shot advice prompt and the starter
# prompt so an Apply on either goes through the same appliers.
proc ::crema::llm::advice_schema {} {
	return {{
  "diagnosis": "<the KEY reason in at most 2 short sentences, MAX 45 words - it shows in a small card, so be terse; no preamble>",
  "confidence": "low" | "medium" | "high",
  "actions": {
    "grind": {"delta": <float, dial units, negative=finer, 0 if none>, "target": <float absolute dial>},
    "dose_g": <float or null>, "target_yield_g": <float or null>, "temperature_c": <float or null>
  },
  "profile": {
    "action": "keep" | "switch" | "create",
    "switch_to": <existing profile title or null>,
    "created_profile": <null, or {"title","notes","target_weight_g","steps":[{"name","temperature","seconds","pump":"pressure"|"flow","pressure","flow","transition":"fast"|"smooth","exit_type","exit_pressure_over","exit_pressure_under","exit_flow_over","exit_flow_under"}]}>,
    "reason": "<1 sentence or empty>"
  },
  "screen_summary": "<max 160 chars, imperative, what to do>"
}}
}

# ---- STARTER prompt: pick a sensible starting point for a bean with NO shots
# yet (roast level + freshness + roaster/coffee knowledge). Same schema as the
# per-shot advice, so the same Apply button applies profile/grind/dose/yield/temp.
proc ::crema::llm::build_starter_prompt {p} {
	set bean    [dict get $p bean]
	set grinder [dict get $p grinder]
	set gname [ifdget $grinder model "grinder"]
	set gset  [ifdget $grinder setting "?"]
	set bname [ifdget $bean name ""]
	set broaster [ifdget $bean roaster ""]
	set broast [ifdget $bean roast_date ""]
	set rlevel [ifdget $bean roast_level ""]
	set broast_age ""
	catch {
		if {[string trim $broast] ne ""} {
			set d [expr {([clock seconds] - [clock scan $broast -format "%Y-%m-%d"]) / 86400}]
			if {$d >= 0 && $d < 3650} { set broast_age " ($d days off roast)" }
		}
	}
	set dose  [ifdget $p dose_g "?"]
	set grange [ifexists ::crema_settings(grinder_range) ""]
	set range_line ""
	if {[string trim $grange] ne ""} { set range_line "Its usable espresso range is roughly $grange - keep the grind inside it. " }
	set level_str ""
	if {[string trim $rlevel] ne ""} { set level_str " - roast level: $rlevel" }

	return "You are a world-class espresso barista and roaster on a Decent DE1. The barista has a NEW bag they have NOT pulled yet - there is NO shot data. Give them the best STARTING point to pull their FIRST shot: a profile, grind, dose, target yield (ratio) and temperature. This is a safe, forgiving starting point to dial in FROM, not a final answer.

## Grinder
$gname. LOWER dial = finer = slower; HIGHER = coarser = faster. Current dial: $gset (this is just where the dial happens to sit - NOT a shot result, ignore it as evidence).
${range_line}Pick a grind on the FINER half of the usable espresso range, and ERR FINE: a too-fine first shot merely runs slow / chokes and is trivially fixed by coarsening a little, but a too-coarse shot gushes, tastes hollow and WASTES the shot. Light roasts especially want it finer. You have no shot data, so this is a deliberately safe, slightly-tight starting grind to dial OUT from, not a middle guess.

## Bean
$bname / $broaster / roasted $broast$broast_age$level_str
If you recognise this roaster or coffee, use what you know (origin, process, typical roast + flavour) to choose the starting point. Otherwise reason from the roast level and freshness:
- Light roast: needs more heat and a finer/longer extraction - start hotter (about 93-95C), a slightly finer grind, a longer ratio (~1:2.2-2.5), often a gentle bloom/preinfusion.
- Medium roast: balanced - about 92-94C, ~1:2, a standard pressure profile.
- Dark roast: extracts easily and scorches - start cooler (about 88-91C), a slightly coarser grind, a shorter ratio (~1:1.8-2), often a declining pressure profile.
- Very fresh (<10 days off roast): lots of CO2 - favour a bloom / longer gentle preinfusion to avoid gushing.
- Older (30+ days): degassed - a touch hotter and/or a longer ratio to lift extraction.

## Profile
Prefer SWITCHING to a well-known DE1 stock profile that fits the roast (e.g. a balanced pressure profile for medium, a gentle/blooming or higher-temp one for light, a lower-temp or declining one for dark) via profile.action \"switch\" with switch_to set to its title; OR action \"create\" a simple 2-4 step profile if that serves the bean better. Any created profile must obey the DE1: pressure 0-10 bar, flow 0-8 mL/s, temp 80-98C, 2-6 steps. 96C is already hot at the puck; 97-98C is the ceiling.

## Output
Fill actions.grind.target with the absolute starting dial (delta 0), dose_g, target_yield_g and temperature_c with the starting recipe. Put the starting point in screen_summary as one imperative line (e.g. \"Start: switch to X, grind 0.6, 18g in, 40g out, 93C\"). Keep the diagnosis TERSE - at most 2 short sentences, 45 words max (it renders in a small card and longer text is cut off). confidence reflects how well you know this bean. Respond with ONLY a valid JSON object in exactly this schema, no prose and no markdown fences. Keep every string value plain text with NO double-quote characters inside it:
[advice_schema]"
}

# ---- prompt builder (Tcl port of prompting.py) ----------------------------
# Segment a shot's OUTPUT curve into preinfusion (slow saturation) vs the actual
# pour, so the model can see WHY a shot fell short instead of re-integrating raw
# arrays in its head (which it doesn't do). A long preinfusion that eats the shot
# is a PROFILE lever, not a grind one - the exact distinction that turns "grind
# coarser" into the right answer or the wrong one. Prefers the real scale output
# (weight_flow, g/s); falls back to the DE1 flow estimate (mL/s) with no scale.
# Returns {preinf_s pour_s pour_avg pour_peak unit choked} or "" if uncomputable.
proc ::crema::llm::flow_phases {p} {
	set wf ""; catch { set wf [dict get $p weight_flow] }
	set unit "g/s"
	set mx 0; catch { set mx [tcl::mathfunc::max 0 {*}$wf] }
	if {![llength $wf] || $mx <= 0.3} {
		set wf ""; catch { set wf [dict get $p flow] }; set unit "mL/s"
	}
	set el ""; catch { set el [dict get $p elapsed] }
	set n [expr {min([llength $wf],[llength $el])}]
	if {$n < 4} { return "" }
	# pour begins at the first output sample that reaches AND holds > 0.8
	set pstart -1
	for {set i 0} {$i < $n} {incr i} {
		if {[lindex $wf $i] > 0.8} {
			set held 1; set jmax [expr {min($i+2,$n-1)}]
			for {set j $i} {$j <= $jmax} {incr j} { if {[lindex $wf $j] <= 0.3} { set held 0; break } }
			if {$held} { set pstart $i; break }
		}
	}
	set tend 0; catch { set tend [lindex $el [expr {$n-1}]] }
	if {![string is double -strict $tend]} { return "" }
	# average & peak PRESSURE during the pre-pour (stall) phase. This is the key
	# disambiguator: a LOW stall pressure means the profile is holding low on
	# purpose (bloom/preinfusion, or a slow pressure ramp) and the fix is the
	# PROFILE - raise/shorten that hold; a HIGH stall pressure with no flow means
	# the puck is CHOKING under full pressure and the grind is genuinely too fine.
	set pr ""; catch { set pr [dict get $p pressure] }
	set stallend [expr {$pstart < 0 ? $n : $pstart}]
	set qsum 0; set qn 0; set qmax 0
	for {set i 0} {$i < $stallend && $i < [llength $pr]} {incr i} {
		set v [lindex $pr $i]
		if {[string is double -strict $v]} { set qsum [expr {$qsum+$v}]; incr qn; if {$v>$qmax} {set qmax $v} }
	}
	set qavg [expr {$qn>0 ? $qsum/double($qn) : 0}]
	if {$pstart < 0} {
		return [list [format %.0f $tend] 0 0 0 $unit 1 [format %.1f $qavg] [format %.1f $qmax]]
	}
	set preinf [lindex $el $pstart]
	set psum 0; set pn 0; set pmax 0
	for {set i $pstart} {$i < $n} {incr i} {
		set v [lindex $wf $i]
		if {[string is double -strict $v]} { set psum [expr {$psum+$v}]; incr pn; if {$v>$pmax} {set pmax $v} }
	}
	set pavg [expr {$pn>0 ? $psum/double($pn) : 0}]
	return [list [format %.0f $preinf] [format %.0f [expr {$tend-$preinf}]] \
		[format %.1f $pavg] [format %.1f $pmax] $unit 0 [format %.1f $qavg] [format %.1f $qmax]]
}

proc ::crema::llm::build_prompt {p previous {rebuttal ""}} {
	set bean    [dict get $p bean]
	set grinder [dict get $p grinder]
	set answers [dict get $p answers]

	set gname [ifdget $grinder model "grinder"]
	set gset  [ifdget $grinder setting "?"]
	set bname [ifdget $bean name ""]
	set broaster [ifdget $bean roaster ""]
	set broast [ifdget $bean roast_date ""]
	set rlevel [ifdget $bean roast_level ""]
	# days off roast - freshness is a first-class variable the advisor must weigh
	set broast_age ""
	catch {
		if {[string trim $broast] ne ""} {
			set d [expr {([clock seconds] - [clock scan $broast -format "%Y-%m-%d"]) / 86400}]
			if {$d >= 0 && $d < 3650} { set broast_age " ($d days off roast)" }
		}
	}

	set dose  [ifdget $p dose_g "?"]
	set yield [ifdget $p final_yield_g "?"]
	set target [ifdget $p target_yield_g "?"]
	set ptitle [ifdget $p profile_title ""]

	# stats
	set elapsed [dict get $p elapsed]
	set dur "?"
	catch { if {[llength $elapsed]} { set dur [format %.1f [lindex $elapsed end]] } }
	set btemp [ifdget $p brew_temp ""]
	set ratio "?"
	catch { if {$dose > 0 && [string is double -strict $yield]} { set ratio "1:[format %.1f [expr {$yield / double($dose)}]]" } }

	# NOTE: basket_temp is deliberately omitted - on the DE1 it's a metal-sensor
	# reading that runs ~20C cooler than the water and misleads temperature advice.
	# The real brew temperature is stated explicitly in the shot section instead.
	# weight comes from the scale: include it only when the curve looks real, so a
	# mis-parsed or absent scale can't feed the model a garbage weight curve.
	set weight_json ""
	catch {
		set wf [dict get $p weight_flow]
		set wmax 0; catch { set wmax [tcl::mathfunc::max {*}$wf] }
		if {[string is double -strict $wmax] && $wmax > 0.3 && $wmax < 6} {
			set weight_json ",\"weight_out_gs\":[jnums [downsample $wf]]"
		}
	}
	# profile TARGET curves (what the profile intended) - present on shots
	# captured after this was added; gracefully absent on older ones.
	set goal_json ""
	catch {
		set pgoal ""; catch { set pgoal [dict get $p pressure_goal] }
		set fgoal ""; catch { set fgoal [dict get $p flow_goal] }
		if {[llength $pgoal] || [llength $fgoal]} {
			set goal_json ",\"pressure_target_bar\":[jnums [downsample $pgoal]],\"flow_target_mls\":[jnums [downsample $fgoal]]"
		}
	}
	set curves "\{\"elapsed_s\":[jnums [downsample $elapsed]],\
\"pressure_bar\":[jnums [downsample [dict get $p pressure]]],\
\"flow_mls\":[jnums [downsample [dict get $p flow]]]${weight_json}${goal_json}\}"

	# phase analysis for THIS shot - preinfusion vs pour, handed over as plain
	# numbers so the model reasons about the split instead of eyeballing arrays
	set phase_line ""
	catch {
		set ph [flow_phases $p]
		if {[llength $ph] == 8} {
			lassign $ph pf pd pa pk un ch qa qk
			if {$ch} {
				set phase_line "\nFlow phases: the puck NEVER reached a normal pour rate in ${pf}s; that stall sat at avg ${qa} bar (peak ${qk} bar). Read the pressure: if the stall pressure is HIGH (say >~6 bar) the puck is CHOKING under full pressure and the grind is too fine (coarsen); if it is LOW the profile never applied enough pressure to drive flow - raise/steepen it (a profile change), keep the grind."
			} else {
				set phase_line "\nFlow phases: time-to-first-real-flow was ~${pf}s (that pre-pour stall sat at avg ${qa} bar, peak ${qk} bar), then the pour ran ~${pd}s at avg ${pa} ${un} (peak ${pk} ${un}). Diagnose from the STALL PRESSURE, not just its length: if the stall pressure was LOW (a designed bloom/preinfusion or a slow pressure ramp, say <~4 bar) the puck is fine but under-pressured - the fix is the PROFILE (raise that hold pressure, ramp faster, or shorten it) and you can KEEP the grind; if it was HIGH (>~6 bar) yet flow still stalled, the puck is choking and the grind is too fine (coarsen). A long stall eating most of the shot while the pour itself flows fine is why yield falls short - do not just grind coarser, which would gush the already-fine pour."
			}
		}
	}

	set hist [history_lines $previous]
	set attempts [attempt_lines $previous]

	# reconsider turn: the barista disagreed with the advice we just gave
	set reconsider ""
	if {[string trim $rebuttal] ne ""} {
		set prior_sum ""; set prior_diag ""
		catch { set prior_sum [dict get $p advice screen_summary] }
		catch { set prior_diag [dict get $p advice diagnosis] }
		set reconsider "\n## RECONSIDER - the barista disagrees with the advice you just gave
Your previous advice for THIS shot: \"$prior_sum\" ($prior_diag)
Their pushback: \"[string trim $rebuttal]\"
Take it seriously - they know their palate, grinder and machine, and may have context the numbers don't show. Re-examine the curves, time and taste with their point in mind. If they are right, CHANGE your recommendation accordingly. If your original still holds, keep it but explain plainly why their concern does not change it - never just repeat the same words, and never cave reflexively just because they pushed back. Make your diagnosis address their point directly.\n"
	}

	set schema [advice_schema]

	set grange [ifexists ::crema_settings(grinder_range) ""]
	set range_line ""
	if {[string trim $grange] ne ""} {
		set range_line "Its usable espresso range is roughly $grange, so calibrate move sizes to that window. "
	}
	set level_str ""
	if {[string trim $rlevel] ne ""} { set level_str " - roast level: $rlevel" }

	set prompt "You are a world-class espresso barista and roaster dialing in a shot on a Decent DE1. Reason carefully about the pressure and flow CURVES (plus the profile's target curves and the weight curve when present), the taste feedback, the bean, and the shot HISTORY together, then recommend the single best change for the next shot. Think like an expert who understands extraction - not a rule-follower.

## Grinder
$gname. LOWER dial = finer = slower shot; HIGHER = coarser = faster. All grind advice is in these dial units. Current dial: $gset.
${range_line}Espresso is EXTREMELY grind-sensitive: make the SMALLEST move the curves+taste justify and CONVERGE (each correction smaller than the last) - never swing between fine and coarse extremes. Judge magnitude from FLOW and TIME, not taste alone; a shot that already pulled in a normal ~25-32s rarely needs a grind change - reach for temperature or ratio instead.

## Bean
$bname / $broaster / roasted $broast$broast_age$level_str
If you recognise this roaster or coffee, use what you know about it - likely roast level, origin, process and typical flavour - to inform the advice (light roasts want more heat and finer/longer extraction; dark roasts less). If you don't recognise it, infer roast level from the taste and curves rather than assuming.
Freshness is a TUNING input, never an excuse. Espresso is liveliest about 7-21 days off roast; by ~30-40+ days beans have degassed and can taste flatter, hollow or salty. But the barista is NOT going to throw the bag away - your job is to get the best possible cup from THESE beans. Use staleness to steer the fix, not to surrender: old beans have lost their CO2, so they extract slowly and unevenly yet also tolerate a MORE aggressive extraction without the gas-driven channeling fresh beans have. Compensate by extracting harder and more evenly - a longer/gentler preinfusion or bloom to wet the degassed puck evenly (a profile change), a finer grind and/or a longer ratio to lift extraction, temperature at the top of its sensible range. You MAY mention in one clause that fresher beans would give more headroom, but your actual recommendation MUST be a concrete grind/ratio/temp/profile/prep change that improves the next shot with the beans in hand.

## This shot
Profile '$ptitle'. ${dose}g in -> target ${target}g, got ${yield}g (ratio ${ratio}). Duration ${dur}s. Brew temperature ${btemp}C (this is the actual water temperature - reason about temperature from THIS number, and state new temps relative to it).
Curves (downsampled, time-aligned arrays): $curves
If pressure_target_bar / flow_target_mls are present, they are what the PROFILE intended - compare them against the actual pressure_bar / flow_mls: if actual tracks target, the machine did its job and the fix lives in grind / ratio / temp / prep; if actual DIVERGES from target (pressure never reached target, or flow ran away from it), that is a profile or puck-prep problem, not a grind one.$phase_line

## Taste (ground truth - weight heavily)
Taste: [ifdget $answers taste_balance {}] | Body: [ifdget $answers body {}] | Flow looked: [ifdget $answers flow_look {}] | Finish: [ifdget $answers aftertaste {}] | Enjoyment: [ifdget $answers enjoyment {}]/5
What tastes tell you about EXTRACTION (read these as evidence, do NOT map a taste straight to a lever): sour/salty -> under-extracted; bitter/harsh -> over-extracted or a pressure spike; short finish -> under-developed; dry/astringent -> over-extraction or channeling; uneven/spritzy/gushing flow -> channeling. The SAME taste calls for different fixes depending on the flow and time: an under-extracted shot that ran FAST wants finer or hotter, but one that already ran SLOW wants a longer ratio, a gentler/bloom profile, or better prep - grinding finer would only choke it further. Decide the fix from taste + curves + time together, never from taste alone.

## Recent shots with this bean (oldest first)
$hist
$attempts

## Your toolkit - pick what THIS shot actually needs; do not default to grind
- Grind: primary lever for extraction rate; small, converging moves only.
- Dose & ratio (yield): for strength and balance.
- Temperature: hotter extracts more (great for sour / light roasts), cooler for bitter / dark. But mind the range: espresso normally lives at 90-96C, and the DE1 delivers the SET temp right at the puck (no boiler-to-group heat loss), so 96C is already genuinely hot - not a mid-point. 97-98C is the practical ceiling and each degree up there is expensive (risks harsh/scorched/bitter), so spend it sparingly: at most a +1C nudge, and only when there is real headroom. When the shot is already at ~95-96C and still under-extracted, temperature is NOT the roomy lever - prefer a longer ratio or better prep to gain extraction instead of pushing water toward boiling.
- Pressure/flow PROFILE: when the curve SHAPE is the problem, or the roast wants it, design a new profile or switch to one. Be proactive - a good profile fixes what grind alone cannot. Light roasts often want a gentle bloom + higher temp; dark roasts often want lower pressure or a declining profile.
- Puck prep: call it out whenever flow is uneven.
$reconsider
## How to reason
Read the curve SHAPE (preinfusion, ramp, plateau, decline; a pressure spike or flow surge = channeling). Correlate shape + time + taste, diagnose the ROOT cause, then choose the single highest-payoff change - prefer the simplest lever that works.

Before you commit, SANITY-CHECK your own diagnosis - this is how an expert avoids a bad call:
- Does the diagnosis agree with the FLOW and TIME? Coarse grinds run FAST, fine grinds run SLOW. So a long/slow shot is evidence AGAINST 'too coarse', and a fast/gushing one is evidence against 'too fine'. If your explanation contradicts the flow, it is probably wrong - re-diagnose before recommending.
- Weigh EVERY lever below against the evidence, not just grind. Ask which one the data actually points to.
- RED FLAG - a long/slow shot that STILL tastes under-extracted (sour/salty): long contact time should OVER-extract, so under-extraction despite it is not a case for a small ratio nudge. It points to CHANNELING (uneven extraction bypassing the puck - often INVISIBLE, the flow can look perfectly even) or STALE beans. Name the root cause, then give the fix that targets it: for channeling, puck prep / WDT / level tamp; for old degassed beans, extract harder and more evenly - a bloom/longer preinfusion plus a finer grind or longer ratio - not a token tweak, and never just tell them to buy new beans.
- SIZE THE MOVE so it can actually be tasted. The 'smallest converging move' rule is for GRIND only, which is hypersensitive. For RATIO and TEMPERATURE a change too small to taste just wastes a shot: a yield change under ~10% (e.g. 36 -> 38 g) is within shot-to-shot noise and will NOT reliably fix a clear fault. If you use ratio to correct a distinct off-taste, move it enough to matter (roughly 1:2.3-2.6) or pick a different lever.
- When the root cause is genuinely ambiguous (as it often is), say so plainly in the diagnosis, give your single best bet, prefer the LOWEST-RISK change, and set confidence to low. Do not invent certainty you don't have - an honest 'try this, and here's what to watch' beats a confident wrong answer.
- IF THE SHOT IS ALREADY GOOD - the barista rates it 4-5/5 AND the taste words are positive (balanced / good / clean / sweet) - the expert move is to LOCK IT IN, not tinker. Set profile action 'keep', grind delta 0 and target = current, dose/yield/temp null, and make the summary 'Dialed in - keep everything and pull it the same way' (optionally ONE small refinement explicitly framed as an experiment they can skip). NEVER switch the profile or make a real grind/ratio/temp move on a shot they are happy with - changing a dialed-in shot is how you lose it. A 5/5 does not need a change to be actionable.

ALWAYS BE ACTIONABLE. Your recommendation must be a concrete change the barista can make RIGHT NOW with the beans and gear they already have - a grind, dose, ratio, temperature, profile or prep change. You may note a limitation (old beans, a flaky scale) in one clause of the diagnosis as context, but never let replacing the beans or buying new equipment BE the advice, and never throw up your hands. There is always a lever that makes the next shot better than this one - find it and recommend it. The ONE exception: a shot the barista already rates 4-5/5 and likes - then 'keep everything and repeat it' IS the correct, actionable answer, so do NOT invent a change just to have one.

These are habits of thought, not a decision table - reason from THIS shot's evidence to whatever answer it supports. Combine changes (e.g. grind + profile) only when truly warranted. Any profile you create must obey the DE1: pressure 0-10 bar, flow 0-8 mL/s, temp 80-98C, 2-6 steps.

Everything in actions/profile is applied by one Apply button, so only include changes you mean, and phrase the summary as what WILL happen. Keep the diagnosis TERSE - at most 2 short sentences, 45 words max - it renders in a small fixed card and longer text is cut off; state only the single key reason, no preamble or full play-by-play. Respond with ONLY a valid JSON object in exactly this schema, no prose and no markdown fences. Keep every string value plain text with NO double-quote characters inside it (use plain words, not quoted phrases), so the JSON always parses:
$schema"
	return $prompt
}

# dict get with default
proc ::crema::llm::ifdget {d key default} {
	if {[catch { dict get $d $key } v]} { return $default }
	if {$v eq "" || $v eq "null"} { return $default }
	return $v
}

# ---- what we already tried on this bean, and how it went ----------------
# history_lines shows each shot's settings and score, which lets the model
# INFER what changed - but inferring it is exactly what a weaker model gets
# wrong, and it will happily re-suggest a lever that already made things
# worse. So the deltas are computed here and stated outright, paired with the
# direction the score then moved.
#
# Only shots that changed something AND earned a score are attempts: a repeat
# teaches nothing about a lever, and an unrated shot has no outcome. An
# unrated shot in the middle does not break the chain - the next scored shot
# is still compared against the last scored one.
proc ::crema::llm::attempt_lines {previous} {
	if {[llength $previous] < 2} { return "" }

	set prev ""
	set prev_score ""
	set out {}

	# previous is newest-first; walk it oldest-first
	foreach rec [lreverse $previous] {
		set a {}
		catch { set a [dict get $rec answers] }
		set score [ifdget $a enjoyment ""]

		if {$prev ne ""} {
			set changes {}

			foreach {field label} {grinder_setting grind dose_g dose target_yield_g yield brew_temp temp} {
				set was [ifdget $prev $field ""]
				set now [ifdget $rec  $field ""]
				if {![string is double -strict $was] || ![string is double -strict $now]} { continue }
				set delta [expr {$now - $was}]
				# ignore float noise and unchanged values
				if {abs($delta) < 0.01} { continue }
				if {$label in {grind temp}} {
					lappend changes [format "%s %s%.2g" $label [expr {$delta > 0 ? "+" : "-"}] [expr {abs($delta)}]]
				} else {
					lappend changes [format "%s %g" $label $now]
				}
			}

			set was_p [ifdget $prev profile_title ""]
			set now_p [ifdget $rec  profile_title ""]
			if {$was_p ne $now_p && $now_p ne ""} { lappend changes "profile $now_p" }

			if {[llength $changes] && [string is double -strict $score]} {
				if {[string is double -strict $prev_score]} {
					if {$score > $prev_score} { set outcome "better" } elseif {$score < $prev_score} { set outcome "worse" } else { set outcome "no change" }
					set from $prev_score
				} else {
					set outcome "no earlier score"
					set from "?"
				}
				lappend out "- [join $changes { + }] -> score $from to $score ($outcome)"
			}
		}

		set prev $rec
		if {[string is double -strict $score]} { set prev_score $score }
	}

	if {![llength $out]} { return "" }

	return "## ALREADY TRIED on this bean (oldest first)
Do NOT repeat a change that made it worse. If a lever moved the score up, consider continuing in that direction rather than switching levers.
[join [lrange $out end-5 end] "\n"]"
}

proc ::crema::llm::history_lines {previous} {
	if {![llength $previous]} { return "(first recorded shot with this bean)" }
	set lines {}
	# previous is newest-first; render oldest-first
	foreach rec [lreverse $previous] {
		set a {}
		catch { set a [dict get $rec answers] }
		set adv {}
		catch { set adv [dict get $rec advice] }
		set when [string range [ifdget $rec created_at ""] 0 15]
		set line "- $when grind=[ifdget $rec grinder_setting ?] dose=[ifdget $rec dose_g ?]g yield=[ifdget $rec final_yield_g ?]g"
		# compact phase tag so the model can see the preinfusion TREND across shots
		# (e.g. preinfusion lengthening as grind goes finer) - the pattern a single
		# shot can't show
		catch {
			set ph [::crema::llm::flow_phases $rec]
			if {[llength $ph] == 8} {
				lassign $ph pf pd pa pk un ch qa qk
				if {$ch} { append line " preinf=${pf}s@${qa}bar(choked)" } else { append line " preinf~${pf}s@${qa}bar pour~${pa}${un}" }
			}
		}
		append line " taste=[ifdget $a taste_balance {}] body=[ifdget $a body {}] flow=[ifdget $a flow_look {}] enjoyment=[ifdget $a enjoyment {}]/5"
		catch {
			set s [ifdget $adv screen_summary ""]
			if {$s ne ""} { append line " | advice: $s" }
		}
		lappend lines $line
	}
	return [join $lines "\n"]
}
