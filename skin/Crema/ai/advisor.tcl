# Crema AI advisor client: ships finished shots + taste answers to the Mac
# advisor server, polls for the AI's dial-in advice, and applies it.

package require http
package require json

namespace eval ::crema {}

# fill defaults WITHOUT clobbering values already loaded from disk
foreach {__k __v} {
	server_url ""
	auto_qa 1
	min_shot_seconds 8
	theme_variant "dark"
	grinder_name ""
	grinder_range ""
	theme_status ""
	ai_mode "standalone"
	ai_provider "anthropic"
	ai_api_key ""
	ai_model ""
	ai_base_url ""
	setup_complete 0
	last_grind ""
} {
	if {![info exists ::crema_settings($__k)]} { set ::crema_settings($__k) $__v }
}
unset -nocomplain __k __v

# clamp long text at a word boundary with an ellipsis
proc ::crema::trim_words {text max} {
	if {[string length $text] <= $max} { return $text }
	set cut [string range $text 0 [expr {$max - 1}]]
	set sp [string last " " $cut]
	if {$sp > [expr {$max / 2}]} { set cut [string range $cut 0 [expr {$sp - 1}]] }
	return "$cut\u2026"
}

# snap a grind value to the 0.05 grid and format it cleanly (0.10 -> 0.1,
# 0.15 -> 0.15) so manual bumps and AI grinds share a consistent fine scale.
proc ::crema::snap_grind {v} {
	if {![string is double -strict $v]} { return $v }
	set v [expr {round($v * 20) / 20.0}]
	set v [format %.2f $v]
	regsub {(\.\d)0$} $v {\1} v
	return $v
}

# Store crema settings at the WRITABLE homedir root - the same place the core
# settings.tdb lives - NOT under the skin folder, which on a tablet can be a
# read-only bundle where writes silently fail (device bug #1).
proc ::crema::settings_filename {} {
	return "[homedir]/crema_settings.tdb"
}

# one-time migration: pull any settings shipped in the old skin-dir location
proc ::crema::legacy_settings_filename {} {
	return "[skin_directory]/crema_settings.tdb"
}

proc ::crema::load_settings {} {
	set loaded 0
	catch {
		array set ::crema_settings [encoding convertfrom utf-8 [read_binary_file [::crema::settings_filename]]]
		set loaded 1
	}
	if {!$loaded} {
		# first run on this device: seed from the bundled defaults, then own it
		catch {
			array set ::crema_settings [encoding convertfrom utf-8 [read_binary_file [::crema::legacy_settings_filename]]]
		}
	}
	# theme_status is a "saved - restart to apply" nudge meant for the moments
	# right after you press the button. It gets persisted with everything else,
	# so it survived the very restart it was asking for and then sat on the
	# settings page claiming a pending change that had already happened.
	set ::crema_settings(theme_status) ""
}

proc ::crema::save_settings {} {
	# the grinder name feeds shot metadata (and thus the advisor prompt)
	catch {
		set ::settings(grinder_model) $::crema_settings(grinder_name)
	}
	if {[catch {
		iconik_array_to_file ::crema_settings [::crema::settings_filename]
	} err]} {
		msg -ERROR "crema: save_settings failed: $err (file [::crema::settings_filename])"
	}
}

namespace eval ::crema::advisor {
	variable last_shot_id ""
	variable poll_attempts 0
	variable max_poll_attempts 60
	variable advice_seen 1

	# snapshot of the just-finished shot, captured at flow-end so that
	# steaming/watering afterwards can't corrupt it. Rating can happen now
	# or later (device bug #4).
	variable pending_shot ""    ;# server mode: the ::shot::create JSON, or ""
	variable pending_desc ""    ;# short label for the "rate later" prompt
	variable pending_record ""  ;# standalone mode: the Crema store record dict

	proc mark_seen {} {
		variable advice_seen
		set advice_seen 1
	}

	proc standalone {} { return [expr {$::crema_settings(ai_mode) eq "standalone"}] }

	# called by the shot-finish hook: freeze this shot's data
	proc capture_shot {} {
		variable pending_shot
		variable pending_desc
		variable pending_record
		if {[standalone]} {
			# don't lose a still-unrated "Rate later" shot when a new shot is
			# pulled: persist it to the store first (as an unrated record, same id,
			# so a later rating just overwrites it) instead of clobbering it.
			if {$pending_record ne ""} { catch { ::crema::store::save $pending_record } }
			if {[catch { set pending_record [::crema::store::capture] } err]} {
				msg -ERROR "crema: capture_shot (store) failed: $err"
				set pending_record ""
			}
		} else {
			if {[catch { set pending_shot [::shot::create] } err]} {
				msg -ERROR "crema: capture_shot failed: $err"
				set pending_shot ""
			}
		}
		set secs "?"
		catch { set secs "[format %.0f [lindex [espresso_elapsed range end end] 0]]s" }
		set bean [string trim $::settings(bean_type)]
		if {$bean eq ""} { set bean "shot" }
		set pending_desc "$bean · $secs"
		# the home chart's idle ghost is now stale
		catch { ::crema::pages::crema_home::ghost_invalidate }
		chime
	}

	# An audible mark at the end of a shot, the way Bestpresso does it. You are
	# looking at the cup and the scale, not the tablet, so the moment the shot
	# is captured and ready to rate is worth hearing.
	#
	# Off by setting crema_settings(shot_chime) to 0. Every call is caught:
	# `borg` only exists on Android, and a missing beep must never be able to
	# interfere with saving a shot.
	proc chime {} {
		if {[ifexists ::crema_settings(shot_chime) 1] == 0} { return }
		catch { borg beep }
	}

	proc has_pending {} {
		variable pending_shot
		variable pending_record
		if {[standalone]} { return [expr {$pending_record ne ""}] }
		return [expr {$pending_shot ne ""}]
	}

	proc clear_pending {} {
		variable pending_shot
		variable pending_desc
		variable pending_record
		set pending_shot ""
		set pending_desc ""
		set pending_record ""
	}

	# Save the shot + rating to the local history WITHOUT calling the AI. Mirrors
	# send_shot_standalone's record assembly (settled final yield + answers) but
	# stores advice as null instead of firing the LLM - for when the barista just
	# wants to log the shot with no wait and no model call.
	proc save_rating_only {answers_list} {
		variable pending_record
		set rec $pending_record
		if {$rec eq ""} { set rec [::crema::store::capture] }
		# upgrade to the settled scale weight, same as the advice path does
		set cap_yield ""
		catch { set cap_yield [dict get $rec final_yield_g] }
		set dw [settled_final_yield $cap_yield]
		if {$dw ne ""} { dict set rec final_yield_g $dw }
		set ans [dict create]
		foreach {k v} $answers_list { dict set ans $k $v }
		dict set rec answers $ans
		dict set rec advice null
		catch { ::crema::store::save $rec }
		clear_pending
	}

	# advice display state, read by the crema_advice page
	variable status "idle"   ;# idle | sending | waiting | done | error
	variable advice
	array set advice {}

	proc json_escape {s} {
		return [string map [list "\\" "\\\\" "\"" "\\\"" "\n" "\\n" "\r" "" "\t" "\\t"] $s]
	}

	# Build {"shot": <v2 shot json>, "answers": {...}} for the server.
	# Uses the frozen snapshot from shot-finish if present (so steaming after
	# the shot doesn't change the curves), else a fresh create.
	proc build_payload {answers_list} {
		variable pending_shot
		if {$pending_shot ne ""} {
			set shot_json $pending_shot
		} else {
			set shot_json [::shot::create]
		}
		set pairs {}
		foreach {k v} $answers_list {
			if {[string is double -strict $v]} {
				lappend pairs "\"[json_escape $k]\": $v"
			} else {
				lappend pairs "\"[json_escape $k]\": \"[json_escape $v]\""
			}
		}
		return "\{\"shot\": $shot_json, \"answers\": \{[join $pairs ", "]\}\}"
	}

	# For compatible-mode (the Mac server), verify the configured server is
	# reachable; if not, auto-discover it on the LAN and re-point, THEN proceed.
	# For direct-API providers, just proceed. ready_cb is always run exactly once.
	# This is what makes a changed Mac IP self-heal instead of failing advice.
	# Cached "the server is reachable" flag. Once a request succeeds (or a health
	# check / discovery confirms the server), skip the pre-flight health round-trip
	# on every subsequent request - so steady-state advice has ZERO discovery
	# overhead. A failed advice request clears it, so the NEXT request re-checks and
	# auto-discovers if the Mac's IP moved.
	variable server_verified 0

	proc ensure_server_reachable {ready_cb} {
		variable server_verified
		if {[::crema::llm::provider] ni {compatible server}} { after 0 $ready_cb ; return }
		# ALWAYS health-check first (2.5s cap, ~50ms when reachable). We must NOT
		# trust a cached server_verified: the Mac's IP changes on DHCP renewal, so a
		# verified flag from a prior shot can point at a now-dead IP. Skipping the
		# check there sent the 90s advice POST straight at the stale IP and hung the
		# whole minute the barista saw. The cheap health probe catches a moved server
		# and hands off to LAN discovery in seconds instead.
		set base [::crema::llm::base_url]
		if {[catch {
			::http::geturl "$base/health" -timeout 2500 \
				-command [list ::crema::advisor::_reach_done $ready_cb]
		}]} {
			::crema::llm::discover_server [list ::crema::advisor::_reach_after $ready_cb]
		}
	}
	proc _reach_done {ready_cb tok} {
		variable server_verified
		set ok 0
		catch { if {[::http::ncode $tok] == 200 && [string match *claude* [::http::data $tok]]} { set ok 1 } }
		catch { ::http::cleanup $tok }
		if {$ok} { set server_verified 1 ; after 0 $ready_cb ; return }
		# unreachable -> scan the LAN for the server, then proceed regardless
		::crema::llm::discover_server [list ::crema::advisor::_reach_after $ready_cb]
	}
	proc _reach_after {ready_cb found} {
		variable server_verified
		if {$found ne ""} { set server_verified 1 }
		after 0 $ready_cb
	}

	proc send_shot {answers_list} {
		variable status
		variable advice_seen
		set advice_seen 0
		set status "waiting"
		::crema::advisor::update_advice_page
		if {[standalone]} {
			ensure_server_reachable [list ::crema::advisor::send_shot_standalone $answers_list]
		} else {
			send_shot_server $answers_list
		}
	}

	# --- standalone: call the AI provider directly, store the result -------
	variable pending_answers ""
	# whether the last advice request was a "starting point" (no shot) - so the
	# error-state "Try again" button knows to re-run the STARTER, not a shot retry
	variable last_request_starter 0

	# The final shot weight (grams), exactly as every de1app skin reads it:
	# ::settings(drink_weight) - the drip-corrected, settled scale weight written by
	# save_drink_weight on after_flow_complete. de1app's own shot save does literally
	# this (shot.tcl):  out = ::settings(drink_weight), fall back to pour_volume.
	#
	# NO sanity band. The old version cross-checked this against a "flow-validated"
	# value and rejected it when they disagreed - but that anchor was pour_volume
	# (a mL volume estimate that balloons on gushers), so a perfectly good scale
	# reading like 45.5g got thrown away and the AI was fed the wrong ratio. de1app
	# trusts drink_weight outright; so do we. ref is unused, kept for call-site compat.
	proc settled_final_yield {{ref ""}} {
		foreach var {::settings(drink_weight) ::de1(final_espresso_weight)} {
			set v ""
			catch { set v [set $var] }
			if {[string is double -strict $v] && $v > 0.3 && $v < 500} {
				return [format %.1f $v]
			}
		}
		return ""
	}

	proc send_shot_standalone {answers_list} {
		variable status
		variable pending_record
		variable pending_answers
		variable last_request_starter
		set last_request_starter 0
		if {![::crema::llm::configured]} {
			set status "error"
			set ::crema::advisor::advice(error) "No API key set. Settings > AI setup."
			::crema::advisor::update_advice_page
			return
		}
		# assemble the payload/record from the frozen shot + answers
		set rec $pending_record
		if {$rec eq ""} { set rec [::crema::store::capture] }
		# The curves were frozen at flow-end, but the FINAL WEIGHT only settles a
		# few seconds later (after_flow_complete -> ::de1(final_espresso_weight) ->
		# ::settings(drink_weight)): the DE1 stops the pump early to leave room for
		# drips, so the weight vector's last value is several grams SHORT of the
		# real drink weight. By questionnaire-submit time that settled value is
		# authoritative - use it so the advisor sees the TRUE yield/ratio, not a
		# pre-drip undercount (which made it wrongly think the shot fell short of
		# target and keep prescribing "extend the yield").
		set cap_yield ""
		catch { set cap_yield [dict get $rec final_yield_g] }
		set dw [settled_final_yield $cap_yield]
		if {$dw ne ""} { dict set rec final_yield_g $dw }
		set ans [dict create]
		foreach {k v} $answers_list { dict set ans $k $v }
		dict set rec answers $ans
		set pending_answers $rec
		::crema::llm::get_advice_async $rec [previous_for $rec] \
			[list ::crema::advisor::standalone_done $rec]
	}

	# recent shots for the same bean, minus this shot's own record
	proc previous_for {rec} {
		set bean ""; catch { set bean [dict get $rec bean name] }
		set myid ""; catch { set myid [dict get $rec id] }
		set out {}
		foreach p [::crema::store::recent 8 $bean] {
			set pid ""; catch { set pid [dict get $p id] }
			if {$pid ne "" && $pid eq $myid} continue
			lappend out $p
		}
		return $out
	}

	# run (or re-run) advice for a shot already in the local store - e.g. one
	# whose advice failed earlier or was never requested. The stored record IS
	# the payload (curves + answers). On success the record is updated in place.
	# cb is called {cb ok <advice>} / {cb error <msg>}.
	proc advise_stored {id cb} {
		if {![::crema::llm::configured]} {
			after 0 [list {*}$cb error "No API key set. Settings > AI setup."]
			return
		}
		set rec [::crema::store::get $id]
		if {![dict size $rec]} {
			after 0 [list {*}$cb error "Shot not found."]
			return
		}
		# route through ensure_server_reachable so a moved Mac-server IP is
		# rediscovered (no-op for direct-provider modes) - same as the shot path
		ensure_server_reachable [list ::crema::llm::get_advice_async $rec [previous_for $rec] \
			[list ::crema::advisor::advise_stored_done $rec $cb]]
	}
	proc advise_stored_done {rec cb outcome payload} {
		if {$outcome ne "ok"} { after 0 [list {*}$cb error $payload]; return }
		dict set rec advice $payload
		catch { ::crema::store::save $rec }
		after 0 [list {*}$cb ok $payload]
	}

	# Re-ask the AI about a stored shot with the barista's disagreement. The
	# revised advice replaces the shot's advice; the reason is kept on the record.
	proc reconsider_stored {id reason cb} {
		if {![::crema::llm::configured]} {
			after 0 [list {*}$cb error "No API key set. Settings > AI setup."]
			return
		}
		set rec [::crema::store::get $id]
		if {![dict size $rec]} {
			after 0 [list {*}$cb error "Shot not found."]
			return
		}
		# route through ensure_server_reachable so a moved Mac-server IP is
		# rediscovered (no-op for direct-provider modes) - Reconsider used to hit
		# the stale IP directly and error instantly when the Mac's DHCP IP changed
		ensure_server_reachable [list ::crema::llm::get_advice_async $rec [previous_for $rec] \
			[list ::crema::advisor::reconsider_done $rec $reason $cb] $reason]
	}
	proc reconsider_done {rec reason cb outcome payload} {
		if {$outcome ne "ok"} { after 0 [list {*}$cb error $payload]; return }
		dict set rec advice $payload
		dict set rec rebuttal $reason
		catch { ::crema::store::save $rec }
		after 0 [list {*}$cb ok $payload]
	}

	# STARTER: for a bean with NO shots yet, ask the AI for a starting point
	# (profile + grind + dose + ratio + temp) from the bean alone. Shows on the
	# advice page like any advice; the same Apply button applies it. Nothing is
	# saved to the shot store (there's no shot) - it's a starting recommendation.
	proc request_starter {} {
		variable status
		variable advice
		variable advice_seen
		variable advice_bean
		variable last_request_starter
		set last_request_starter 1
		if {![::crema::llm::configured]} {
			set status "error"
			set advice(error) "No API key set. Settings > AI setup."
			update_advice_page
			return
		}
		# a starting point leans hardest on the roast level - without it the rec is
		# a guess. Nudge the barista to set it (one tap on the Beans page) before
		# spending a call, but leave the "Get a starting point" button in place.
		if {[string trim [ifexists ::settings(bean_roast_level) ""]] eq ""} {
			set status "empty"
			update_advice_page
			catch { dui item config crema_advice adv_wait \
				-text "Set the roast level on the Beans page first (light / medium / dark).\nIt's the biggest input for a good starting point - then tap Get a starting point." }
			return
		}
		set advice_seen 0
		set status "waiting"
		set advice_bean [string trim [ifexists ::settings(bean_type) ""]]
		update_advice_page
		set rec [dict create \
			bean [dict create name [string trim [ifexists ::settings(bean_type) ""]] \
				roaster [string trim [ifexists ::settings(bean_brand) ""]] \
				roast_date [ifexists ::settings(roast_date) ""] \
				roast_level [ifexists ::settings(bean_roast_level) ""]] \
			grinder [dict create \
				model [ifexists ::crema_settings(grinder_name) [ifexists ::settings(grinder_model) ""]] \
				setting [ifexists ::settings(grinder_setting) ""]] \
			dose_g [ifexists ::settings(grinder_dose_weight) ""]]
		ensure_server_reachable [list ::crema::llm::get_advice_async $rec {} [list ::crema::advisor::starter_done] "" 1]
	}

	proc starter_done {outcome payload} {
		variable status
		variable advice
		variable advice_bean
		variable server_verified
		if {$outcome ne "ok"} {
			msg -ERROR "crema: starter advice failed: $payload"
			set server_verified 0
			set status "error"
			set advice(error) $payload
			deliver_advice
			return
		}
		set server_verified 1
		ingest_advice $payload
		set advice_bean [string trim [ifexists ::settings(bean_type) ""]]
		set status "done"
		catch { msg -INFO "crema: starter advice: $advice(summary)" }
		deliver_advice
	}

	# re-run advice on EVERY stored shot with the current provider/prompt.
	# Oldest-first so each shot's history reflects the updated earlier advice.
	# Synchronous (blocks) - it's a one-off batch, run off the main UI flow.
	proc readvise_all {} {
		if {![::crema::llm::configured]} { msg -ERROR "crema: readvise_all: not configured"; return }
		set ids {}
		catch {
			foreach f [glob -nocomplain "[::crema::store::dir]/*.shot"] {
				set b [file rootname [file tail $f]]
				if {[string is integer -strict $b]} { lappend ids $b }
			}
		}
		set ids [lsort -integer $ids]
		set n [llength $ids]
		set i 0
		foreach id $ids {
			incr i
			set rec [::crema::store::get $id]
			if {![dict size $rec]} { continue }
			if {[catch {
				set adv [::crema::llm::get_advice $rec [previous_for $rec]]
				dict set rec advice $adv
				::crema::store::save $rec
				msg -INFO "crema: readvise ${i}/${n} id=$id -> [dict get $adv screen_summary]"
			} e]} {
				msg -ERROR "crema: readvise ${i}/${n} id=$id FAILED: $e"
			}
		}
		msg -INFO "crema: readvise_all done ($n shots)"
	}

	# re-request advice for the last shot after a failure, without losing it
	proc retry {} {
		variable status
		variable pending_answers
		variable last_request_starter
		if {![::crema::llm::configured]} {
			set status "error"
			set ::crema::advisor::advice(error) "No API key set. Settings > AI setup."
			::crema::advisor::update_advice_page
			return
		}
		# No pending shot to resend means the failed request was a STARTING-POINT
		# (there's no other way to reach the error state without a pending shot).
		# Re-run the starter - this also works after an app restart, where the
		# last_request_starter flag has reset but pending_answers is still empty.
		if {$last_request_starter || $pending_answers eq ""} {
			request_starter
			return
		}
		set ::crema::advisor::advice_seen 0
		set status "waiting"
		::crema::advisor::update_advice_page
		set rec $pending_answers
		ensure_server_reachable [list ::crema::llm::get_advice_async $rec [previous_for $rec] \
			[list ::crema::advisor::standalone_done $rec]]
	}

	proc standalone_done {rec outcome payload} {
		variable status
		variable advice
		variable server_verified
		if {$outcome ne "ok"} {
			msg -ERROR "crema: standalone advice failed: $payload"
			set server_verified 0
			set status "error"
			set advice(error) $payload
			# keep the rated shot + feedback so it isn't lost and can be retried
			catch { ::crema::store::save $rec }
			deliver_advice
			return
		}
		set server_verified 1
		ingest_advice $payload
		variable advice_bean
		set advice_bean ""
		catch { set advice_bean [string trim [dict get $rec bean name]] }
		# persist the rated shot + its advice to local memory
		dict set rec advice $payload
		catch { ::crema::store::save $rec }
		set status "done"
		msg -INFO "crema: advice (standalone): $advice(summary)"
		deliver_advice
	}

	proc send_shot_server {answers_list} {
		variable status
		variable poll_attempts
		if {[catch {
			set payload [build_payload $answers_list]
			set url "$::crema_settings(server_url)/shot"
			set status "sending"
			::http::geturl $url -method POST -type "application/json" \
				-query [encoding convertto utf-8 $payload] -timeout 15000 \
				-command ::crema::advisor::send_done
			set poll_attempts 0
		} err]} {
			msg -ERROR "crema: send_shot failed: $err"
			set status "error"
			set ::crema::advisor::advice(error) "Could not reach advisor: $err"
			::crema::advisor::update_advice_page
		}
	}

	proc send_done {token} {
		variable status
		variable last_shot_id
		if {[catch {
			set ncode [::http::ncode $token]
			set body [encoding convertfrom utf-8 [::http::data $token]]
			::http::cleanup $token
			if {$ncode != 200} { error "server returned $ncode" }
			set response [::json::json2dict $body]
			set last_shot_id [dict get $response shot_id]
			set status "waiting"
			::crema::advisor::update_advice_page
			after 4000 [list ::crema::advisor::poll_advice]
			msg -INFO "crema: shot sent, id=$last_shot_id"
		} err]} {
			msg -ERROR "crema: send_done failed: $err"
			set status "error"
			set ::crema::advisor::advice(error) "Upload failed: $err"
			::crema::advisor::update_advice_page
		}
	}

	proc poll_advice {} {
		variable last_shot_id
		variable poll_attempts
		variable max_poll_attempts
		variable status
		if {$status ne "waiting"} { return }
		if {[incr poll_attempts] > $max_poll_attempts} {
			set status "error"
			set ::crema::advisor::advice(error) "Timed out waiting for advice"
			::crema::advisor::update_advice_page
			return
		}
		if {[catch {
			::http::geturl "$::crema_settings(server_url)/advice/$last_shot_id" \
				-timeout 10000 -command ::crema::advisor::poll_done
		} err]} {
			msg -ERROR "crema: poll failed: $err"
			after 5000 [list ::crema::advisor::poll_advice]
		}
	}

	proc poll_done {token} {
		variable status
		variable advice
		if {$status ne "waiting"} { catch { ::http::cleanup $token }; return }
		# NOTE: no `return` inside the catch body — catch intercepts it as an
		# error code and we'd schedule the poll loop twice per cycle.
		set action repoll
		if {[catch {
			set body [encoding convertfrom utf-8 [::http::data $token]]
			::http::cleanup $token
			set response [::json::json2dict $body]
			set rstatus [dict get $response status]
			if {$rstatus eq "error"} {
				set status "error"
				set advice(error) [dict get $response error]
				set action refresh
			} elseif {$rstatus eq "done"} {
				ingest_advice [dict get $response advice]
				set status "done"
				set action deliver
				msg -INFO "crema: advice received: $advice(summary)"
			}
		} err]} {
			msg -ERROR "crema: poll_done failed: $err"
		}
		if {$action eq "repoll"} {
			after 5000 [list ::crema::advisor::poll_advice]
		} elseif {$action eq "deliver"} {
			::crema::advisor::deliver_advice
		} else {
			::crema::advisor::update_advice_page
		}
	}

	# Parse a server advice dict into the local advice array
	proc ingest_advice {adv} {
		variable advice
		array unset advice
		set advice(summary)    [dict get $adv screen_summary]
		set advice(diagnosis)  [dict get $adv diagnosis]
		set advice(confidence) [dict get $adv confidence]
		foreach {key path} {
			grind_delta  {actions grind delta}
			grind_target {actions grind target}
			dose_g       {actions dose_g}
			yield_g      {actions target_yield_g}
			temp_c       {actions temperature_c}
		} {
			set advice($key) ""
			catch {
				set v [dict get $adv {*}$path]
				if {[string is double -strict $v]} { set advice($key) $v }
			}
		}
		set advice(profile_action) "keep"
		set advice(profile_switch_to) ""
		set advice(profile_reason) ""
		catch { set advice(profile_action) [dict get $adv profile action] }
		catch { set advice(profile_switch_to) [dict get $adv profile switch_to] }
		catch { set advice(profile_reason) [dict get $adv profile reason] }
		set advice(created_profile) ""
		catch {
			set cp [dict get $adv profile created_profile]
			if {[dict exists $cp steps]} { set advice(created_profile) $cp }
		}
	}

	# Apply a stored shot's advice dict directly (from the history detail page):
	# load it into the advice array, then run the same appliers as the live
	# screen (grind number, dose/yield/temp -> profile + DE1, profile create/switch).
	proc apply_stored_advice {adv} {
		variable advice
		ingest_advice $adv
		# PROFILE FIRST - it loads the profile's own yield/temp, so it must run
		# before the recipe or it clobbers the AI's target_yield/temperature.
		set made_profile 0
		if {$advice(created_profile) ne ""} {
			apply_created_profile
			set made_profile 1
		} elseif {$advice(profile_action) eq "switch" && $advice(profile_switch_to) ni {"" null}} {
			apply_profile_switch
		}
		if {$advice(grind_target) ne "" && $advice(grind_target) != $::settings(grinder_setting)} {
			apply_grind
		}
		apply_recipe
		# Give this bean its OWN named AI profile. created_profile already saved
		# under this name; for switch/keep we snapshot the now-loaded profile +
		# recipe so Apply ALWAYS yields "AI · <bean>" instead of leaving a shared
		# profile like "Best overall pressure profile" active.
		if {!$made_profile} { save_bean_profile }
	}

	# After an app restart the advisor memory is empty but the last shot's
	# advice is still saved - reload it (marked seen: no chip). Standalone reads
	# the local store; server mode asks the Mac server.
	proc hydrate_from_server {} {
		if {[standalone]} { hydrate_local; return }
		if {[catch {
			::http::geturl "$::crema_settings(server_url)/shots?limit=1" 				-timeout 6000 -command ::crema::advisor::hydrate_done
		}]} {
			catch { dui item config crema_advice adv_wait 				-text "No advice yet - pull a shot and rate it." }
		}
	}

	# the bean the in-memory advice belongs to (so the home strip can tell whether
	# the loaded advice is for the currently-selected bean or a different one)
	variable advice_bean ""
	# whether the current bean has ANY stored shots (vs a brand-new, never-pulled
	# bean) - lets the empty advice state show the right message
	variable advice_has_shots 0

	proc current_bean {} { return [string trim [ifexists ::settings(bean_type) ""]] }

	# Standalone: pull the CURRENT BEAN's most recent stored shot and show its
	# advice. Bean-scoped so switching beans doesn't surface another bean's advice.
	proc hydrate_local {} {
		variable status
		variable advice_seen
		variable advice_bean
		# don't stomp an advice request that's still in flight (e.g. the user
		# switched beans while "Asking the AI..." was showing) - let its callback
		# resolve the status; we'd otherwise wipe the waiting/sending indicator
		if {$status in {sending waiting}} { return }
		variable advice_has_shots
		set bean [current_bean]
		set got 0
		set nshots 0
		catch {
			# scan the recent shots (not just the newest) for the latest one that
			# actually HAS advice - the newest shot may be a "Save only" / failed
			# one with no advice, but older shots for this bean still have it
			set recent [::crema::store::recent 8 $bean]
			set nshots [llength $recent]
			foreach rec $recent {
				set adv "null"
				catch { set adv [dict get $rec advice] }
				if {$adv ne "null" && [dict exists $adv screen_summary]} {
					ingest_advice $adv
					set advice_bean $bean
					set status "done"
					set advice_seen 1
					set got 1
					break
				}
			}
		}
		if {$got} { update_advice_page; return }
		# no ADVICE for THIS bean - clear any stale (other-bean) advice so the
		# home strip and advice page don't show a different bean's recommendation.
		# advice_has_shots distinguishes "bean has shots but none advised" (rate one
		# with Get advice) from "brand-new bean, zero shots" (get a starting point).
		array unset advice
		array set advice {}
		set advice_bean $bean
		set advice_has_shots [expr {$nshots > 0}]
		set status "empty"
		update_advice_page
	}

	# Snapshot the live dial-in (profile / grind / dose / yield) into the CURRENT
	# bean's library record. Called after applying AI advice so a bean with no
	# shots yet (a fresh starting point) restores correctly when re-selected -
	# otherwise the starter's profile vanished the moment another bean loaded.
	proc persist_bean_dialin {} {
		set bn [current_bean]
		if {$bn eq ""} { return }
		catch {
			set beans [ifexists ::crema_settings(beans) {}]
			set idx -1; set i 0
			foreach b $beans {
				set nm ""; catch { set nm [string trim [dict get $b name]] }
				if {$nm eq $bn} { set idx $i; break }
				incr i
			}
			if {$idx < 0} { return }
			set b [lindex $beans $idx]
			# NEVER record ANOTHER bean's "AI ." profile as this bean's own - that
			# made a fresh bean wear the previous bean's profile permanently
			set pf [ifexists ::settings(profile_title) ""]
			if {[string match "AI *" $pf] && ![string match "*$bn*" $pf]} { set pf "" }
			dict set b dialin_profile $pf
			dict set b dialin_grind   [ifexists ::settings(grinder_setting) ""]
			dict set b dialin_dose    [ifexists ::settings(grinder_dose_weight) ""]
			dict set b dialin_yield   [ifexists ::settings(final_desired_shot_weight) ""]
			set ::crema_settings(beans) [lreplace $beans $idx $idx $b]
			::crema::save_settings
		}
	}

	# restore a bean's saved starter dial-in from its library record - used only
	# when the bean has no shots to restore from
	proc restore_bean_snapshot {bean do_grind} {
		set got_profile 0
		foreach b [ifexists ::crema_settings(beans) {}] {
			set nm ""; catch { set nm [string trim [dict get $b name]] }
			if {$nm ne $bean} { continue }
			catch {
				if {[dict exists $b dialin_profile]} {
					set pt [dict get $b dialin_profile]
					# only this bean's OWN profile (its name) or a neutral one - never
					# another bean's "AI ." profile that may have leaked into the record
					set is_other_ai [expr {[string match "AI *" $pt] && ![string match "*$bean*" $pt]}]
					if {$pt ne "" && $pt ne "Saved" && !$is_other_ai} {
						if {$pt ne [ifexists ::settings(profile_title) ""]} {
							set fn [resolve_profile_file $pt]
							if {$fn ne ""} { select_profile $fn }
						}
						set got_profile 1
					}
				}
			}
			if {$do_grind} {
				catch { if {[dict exists $b dialin_grind]} { set g [dict get $b dialin_grind]
					if {[string is double -strict $g] && $g > 0} { set ::settings(grinder_setting) $g; set ::crema_settings(last_grind) $g } } }
			}
			catch { if {[dict exists $b dialin_yield]} { set y [dict get $b dialin_yield]
				if {[string is double -strict $y] && $y > 0} { set ::settings(final_desired_shot_weight) $y; set ::settings(final_desired_shot_weight_advanced) $y } } }
			catch { if {[dict exists $b dialin_dose]} { set d [dict get $b dialin_dose]
				if {[string is double -strict $d] && $d > 0} { set ::settings(grinder_dose_weight) $d } } }
			catch { ::save_settings }
			catch { send_de1_settings_soon }
			break
		}
		return $got_profile
	}

	# Self-heal: if the current bean is wearing ANOTHER bean's "AI ." profile (a
	# fresh bean inherits the previous profile and only a bean SWITCH corrects it,
	# so on boot/direct-view it can stay wrong), re-run the bean's dial-in restore,
	# which loads its own profile (from a shot or snapshot) or a neutral default.
	proc ensure_bean_profile {} {
		set bn [current_bean]
		if {$bn eq ""} { return }
		set cur [ifexists ::settings(profile_title) ""]
		if {[string match "AI *" $cur] && ![string match "*$bn*" $cur]} {
			restore_bean_dialin $bn
		}
	}

	# Auto-restore a bean's dial-in when it's selected: pull that bean's most
	# recent shot and put the machine back where it was for those beans (grind,
	# yield, dose, profile), then re-point the AI strip/history at this bean.
	# Safe settings apply directly; the profile goes through select_profile.
	proc restore_bean_dialin {bean {do_grind 1}} {
		set bean [string trim $bean]
		if {$bean eq ""} { hydrate_local; return }
		set recent {}
		catch { set recent [::crema::store::recent 1 $bean] }
		if {[llength $recent]} {
			set rec [lindex $recent 0]
			# Load the profile FIRST - select_profile pulls in the profile's own
			# yield/temperature, so it must run BEFORE we restore this bean's
			# grind/yield/dose, otherwise it would clobber the values we just set.
			catch {
				set pt [dict get $rec profile_title]
				if {$pt ne "" && $pt ne "Saved" && $pt ne [ifexists ::settings(profile_title) ""]} {
					set fn [resolve_profile_file $pt]
					if {$fn ne ""} { select_profile $fn }
				}
			}
			if {$do_grind} {
			catch {
				set g [dict get $rec grinder_setting]
				if {[string is double -strict $g] && $g > 0} {
					set ::settings(grinder_setting) $g
					set ::crema_settings(last_grind) $g
				}
			}
			}
			catch {
				set y [dict get $rec target_yield_g]
				if {[string is double -strict $y] && $y > 0} {
					set ::settings(final_desired_shot_weight) $y
					set ::settings(final_desired_shot_weight_advanced) $y
				}
			}
			catch {
				set d [dict get $rec dose_g]
				if {[string is double -strict $d] && $d > 0} { set ::settings(grinder_dose_weight) $d }
			}
			catch { ::save_settings }
			catch { ::crema::save_settings }
			catch { send_de1_settings_soon }
		} else {
			# no shots - restore this bean's saved STARTER dial-in if it has one, so
			# a starting point survives bean switches. If it has no profile of its
			# own, reset to a neutral default so it never wears the PREVIOUS bean's.
			set had_profile 0
			catch { set had_profile [restore_bean_snapshot $bean $do_grind] }
			if {!$had_profile} {
				catch {
					if {[ifexists ::settings(profile_title) ""] ne "Best overall pressure profile"} {
						set fn [resolve_profile_file "Best overall pressure profile"]
						if {$fn ne ""} { select_profile $fn ; catch { ::save_settings } }
					}
				}
			}
		}
		# re-point the AI strip/advice page at this bean (shows its last advice,
		# or clears to "pull a shot" when the bean is new)
		hydrate_local
		catch { ::crema::pages::crema_home::refresh_ai_note }
	}

	proc hydrate_done {token} {
		variable status
		variable advice_seen
		set got 0
		if {![catch {
			set body [encoding convertfrom utf-8 [::http::data $token]]
			::http::cleanup $token
			set shots [dict get [::json::json2dict $body] shots]
			if {[llength $shots]} {
				set adv [dict get [lindex $shots 0] advice]
				if {$adv ne "null" && [dict exists $adv screen_summary]} {
					ingest_advice $adv
					set status "done"
					set advice_seen 1
					set got 1
				}
			}
		} err]} {
			if {$got} {
				update_advice_page
				return
			}
		}
		if {$got} { update_advice_page; return }
		catch { dui item config crema_advice adv_wait 			-text "No advice yet - pull a shot and rate it." }
	}

	# Push current state into the crema_advice page widgets (safe anytime)
	proc update_advice_page {} {
		catch { ::crema::pages::advice_refresh }
	}

	# Advice arrived: fill the page if it happens to be showing; everywhere
	# else the home-screen chip announces it. Nothing navigates on its own.
	proc deliver_advice {} {
		set cur ""
		catch { set cur [dui page current] }
		if {$cur eq "crema_advice"} {
			update_advice_page
		}
		catch { ::crema::pages::crema_home::refresh_ai_note }
	}

	proc apply_grind {} {
		variable advice
		if {$advice(grind_target) eq ""} { return }
		# Apply the AI's grind target AS-IS. (An earlier version clamped it to
		# ::crema_settings(grinder_range), but that range is user-configured and
		# often wrong - e.g. it said 0.4-1.0 while the user actually grinds at
		# 0.1-0.2 - so the clamp forced the AI's fine 0.15 up to 0.4. The AI is
		# already told the range in the prompt; don't second-guess its number.)
		set gt $advice(grind_target)
		# sanity only: reject a truly nonsensical value (non-numeric / <=0 / absurd)
		if {![string is double -strict $gt] || $gt <= 0 || $gt > 100} {
			msg -ERROR "crema: apply_grind ignoring nonsensical target '$gt'"
			return
		}
		set ::settings(grinder_setting) $gt
		# remember it in Crema's durable store too, so the next feedback page opens
		# on the applied grind instead of a reverted ::settings value
		set ::crema_settings(last_grind) $gt
		catch { ::save_settings }
		catch { ::crema::save_settings }
		msg -INFO "crema: grinder setting updated to $gt"
	}

	# dose / yield / temperature in one tap
	# ---- undo -------------------------------------------------------------
	# Apply is otherwise a one-way door: it can move the grind, the dose, the
	# yield, every step's temperature AND the selected profile in one press, and
	# putting that back by hand at 6am is miserable.
	#
	# The snapshot is taken verbatim rather than re-derived. Temperature in
	# particular is applied as a DELTA across every profile step, so recomputing
	# the inverse would drift; storing the whole advanced_shot list and the
	# temperature scalars restores exactly what was there.
	variable undo_snapshot ""

	# Settings restored as plain scalars. advanced_shot and the profile are
	# handled separately because they need ordering care.
	variable undo_keys {
		grinder_setting grinder_dose_weight
		final_desired_shot_weight final_desired_shot_weight_advanced
		espresso_temperature espresso_temperature_0 espresso_temperature_1
		espresso_temperature_2 espresso_temperature_3
	}

	proc snapshot_state {} {
		variable undo_keys
		set snap [dict create]
		dict set snap profile_title [ifexists ::settings(profile_title) ""]
		foreach k $undo_keys {
			if {[info exists ::settings($k)]} { dict set snap $k $::settings($k) }
		}
		catch { dict set snap advanced_shot $::settings(advanced_shot) }
		catch { dict set snap last_grind [ifexists ::crema_settings(last_grind) ""] }
		return $snap
	}

	proc restore_state {snap} {
		variable undo_keys
		if {![llength $snap]} { return 0 }

		# PROFILE FIRST, for the same reason apply_all applies it first:
		# select_profile loads that profile's own yield/temperature/dose and
		# would clobber the scalars restored below.
		set title ""
		catch { set title [dict get $snap profile_title] }
		if {$title ne "" && $title ne [ifexists ::settings(profile_title) ""]} {
			set fn [resolve_profile_file $title]
			if {$fn eq ""} {
				# Not fatal: the scalars and steps below still put the machine
				# back where it was, which is most of what undo means.
				msg -ERROR "crema: undo could not find profile '$title'; restoring settings only"
			} elseif {[catch { select_profile $fn } err]} {
				msg -ERROR "crema: undo failed to reselect '$title': $err"
			}
		}

		foreach k $undo_keys {
			if {[dict exists $snap $k]} { set ::settings($k) [dict get $snap $k] }
		}
		catch { if {[dict exists $snap advanced_shot]} { set ::settings(advanced_shot) [dict get $snap advanced_shot] } }
		catch { if {[dict exists $snap last_grind]} { set ::crema_settings(last_grind) [dict get $snap last_grind] } }

		catch { ::save_settings }
		catch { ::crema::save_settings }
		catch { send_de1_settings_soon }
		return 1
	}

	# Called immediately before Apply changes anything.
	proc capture_undo {} {
		variable undo_snapshot
		set undo_snapshot [snapshot_state]
		msg -INFO "crema: undo point captured"
	}

	proc can_undo {} {
		variable undo_snapshot
		return [expr {[llength $undo_snapshot] > 0}]
	}

	# One-shot: the snapshot is cleared so a second press cannot re-apply stale
	# state over something the user has since changed by hand.
	proc undo_last_apply {} {
		variable undo_snapshot
		if {![llength $undo_snapshot]} { return 0 }
		set snap $undo_snapshot
		set undo_snapshot ""
		set ok [restore_state $snap]
		msg -INFO "crema: undo [expr {$ok ? {restored} : {found nothing to restore}}]"
		return $ok
	}

	proc apply_recipe {} {
		variable advice
		if {$advice(dose_g) ne ""} {
			set ::settings(grinder_dose_weight) $advice(dose_g)
		}
		if {$advice(yield_g) ne ""} {
			set ::settings(final_desired_shot_weight) $advice(yield_g)
			set ::settings(final_desired_shot_weight_advanced) $advice(yield_g)
		}
		if {$advice(temp_c) ne ""} {
			apply_temp_target $advice(temp_c)
		}
		catch { ::save_settings }
		catch { send_de1_settings_soon }
		msg -INFO "crema: recipe applied dose=$advice(dose_g) yield=$advice(yield_g) temp=$advice(temp_c)"
	}

	# Shift every temperature in the active profile so its main step hits
	# $target (advanced profiles carry per-step temps; classic ones one temp)
	proc apply_temp_target {target} {
		if {$::settings(settings_profile_type) in {settings_2c settings_2c2}} {
			# Anchor on the MAIN extraction temperature, not the first step - the
			# first step is often a cooler preinfusion, and shifting by its delta
			# would leave the main step off the number the AI actually asked for.
			# Use the profile's stated brew temp (espresso_temperature); fall back
			# to the hottest step (the main extraction step).
			set ref [ifexists ::settings(espresso_temperature) ""]
			if {![string is double -strict $ref]} {
				set ref ""
				foreach step $::settings(advanced_shot) {
					catch {
						set t [dict get $step temperature]
						if {[string is double -strict $t] && ($ref eq "" || $t > $ref)} { set ref $t }
					}
				}
			}
			if {$ref eq "" || ![string is double -strict $ref]} { set ref $target }
			set delta [expr {$target - $ref}]
			set new_steps {}
			foreach step $::settings(advanced_shot) {
				catch {
					dict set step temperature \
						[round_to_one_digits [expr {[dict get $step temperature] + $delta}]]
				}
				lappend new_steps $step
			}
			set ::settings(advanced_shot) $new_steps
			# shift the simple-editor MIRROR temps by the same delta (preserve the
			# profile's per-phase shape) rather than flattening them all to $target -
			# a later profile-type switch would otherwise surface wrong flat temps
			catch {
				foreach i {0 1 2 3} {
					set cur [ifexists ::settings(espresso_temperature_$i) ""]
					if {[string is double -strict $cur]} {
						set ::settings(espresso_temperature_$i) \
							[round_to_one_digits [expr {$cur + $delta}]]
					}
				}
			}
		} else {
			# classic single-temperature profile: one temp everywhere
			catch { foreach i {0 1 2 3} { set ::settings(espresso_temperature_$i) $target } }
		}
		set ::settings(espresso_temperature) $target
	}

	# One AI profile slot per bean: every AI-created profile for this bean
	# saves under the same title, overwriting the previous version. Keeps the
	# profile picker clean; old versions live on inside saved shots.
	proc ai_profile_title {} {
		set bean [string trim $::settings(bean_type)]
		if {$bean eq ""} { set bean [string trim $::settings(bean_brand)] }
		if {$bean eq ""} { set bean "house" }
		return "AI · [string range $bean 0 24]"
	}

	# Build and activate a AI-authored advanced (step-based) profile
	proc apply_created_profile {} {
		variable advice
		set cp $advice(created_profile)
		if {$cp eq ""} { return }
		if {[catch {
			set steps {}
			foreach s [dict get $cp steps] {
				set step [dict create \
					name [dict get $s name] \
					temperature [dict get $s temperature] \
					seconds [dict get $s seconds] \
					transition [expr {[dict exists $s transition] ? [dict get $s transition] : "fast"}] \
					sensor coffee \
					pressure 0 flow 0 volume 100 \
					exit_if 0 exit_flow_under 0 exit_flow_over 6 \
					exit_pressure_under 0 exit_pressure_over 11]
				if {[dict get $s pump] eq "flow"} {
					dict set step pump flow
					dict set step flow [dict get $s flow]
				} else {
					dict set step pump pressure
					dict set step pressure [dict get $s pressure]
				}
				foreach k {exit_type exit_pressure_over exit_pressure_under exit_flow_over exit_flow_under} {
					if {[dict exists $s $k] && [dict get $s $k] ni {null ""}} {
						dict set step $k [dict get $s $k]
						dict set step exit_if 1
					}
				}
				lappend steps $step
			}
			if {![llength $steps]} { error "no steps" }

			set title [ai_profile_title]
			set claude_title ""
			catch { set claude_title [dict get $cp title] }
			set ::settings(advanced_shot) $steps
			set ::settings(settings_profile_type) settings_2c
			set ::settings(profile_title) $title
			set ::settings(profile_to_save) $title
			set ::settings(profile) $title
			catch {
				set notes [dict get $cp notes]
				if {$claude_title ne ""} { set notes "$claude_title — $notes" }
				set ::settings(profile_notes) $notes
			}
			catch {
				set tw [dict get $cp target_weight_g]
				if {[string is double -strict $tw]} {
					set ::settings(final_desired_shot_weight) $tw
					set ::settings(final_desired_shot_weight_advanced) $tw
				}
			}
			catch { set ::settings(espresso_temperature) [dict get [lindex $steps 0] temperature] }
			save_profile
			# save_profile leaves profile_title as the literal "Saved"
			set ::settings(profile_title) $title
			catch { ::save_settings }
			catch { send_de1_settings_soon }
			msg -INFO "crema: created + activated profile '$title' ([llength $steps] steps)"
		} err]} {
			msg -ERROR "crema: apply_created_profile failed: $err"
		}
	}

	proc apply_profile_switch {} {
		variable advice
		if {![info exists advice(profile_switch_to)] || $advice(profile_switch_to) in {"" null}} { return }
		set title [string trim $advice(profile_switch_to)]
		set fn [resolve_profile_file $title]
		if {$fn eq ""} {
			msg -ERROR "crema: profile '$title' not found - not switching"
			return
		}
		if {[catch { select_profile $fn } err]} {
			msg -ERROR "crema: profile switch to '$title' ($fn) failed: $err"
			return
		}
		msg -INFO "crema: switched profile to '$title' (file '$fn')"
	}

	# Snapshot the currently-loaded profile (its curve + the recipe just applied)
	# under a bean-specific AI name and activate it, so applying advice ALWAYS
	# leaves this bean with its own profile in the list (e.g. "AI · abel salinas")
	# instead of borrowing a shared one. Mirrors apply_created_profile's save tail.
	# Called after apply_recipe so the AI's yield/temp are baked into the saved file.
	proc save_bean_profile {} {
		if {[catch {
			set ai_title [ai_profile_title]
			set src [string trim [ifexists ::settings(profile_title) ""]]
			set ::settings(profile_title) $ai_title
			set ::settings(profile_to_save) $ai_title
			set ::settings(profile) $ai_title
			# note where it came from, but don't stack "Based on AI · ..." chains
			catch {
				if {$src ne "" && $src ne $ai_title && ![string match "AI *" $src]} {
					set ::settings(profile_notes) "Based on $src"
				}
			}
			save_profile
			# save_profile overwrites profile_title with the literal "Saved"
			set ::settings(profile_title) $ai_title
			catch { ::save_settings }
			catch { send_de1_settings_soon }
			msg -INFO "crema: saved bean profile '$ai_title' (from '$src')"
		} err]} {
			msg -ERROR "crema: save_bean_profile failed: $err"
		}
	}

	# Resolve an AI-supplied profile TITLE to an actual profile file basename
	# (what select_profile wants), tolerating case + space/underscore differences -
	# the model may say "Blooming espresso" when the file is "Blooming Espresso".
	# Returns "" if nothing matches, so a bad name is skipped rather than crashing.
	proc resolve_profile_file {title} {
		set files {}
		catch { set files [glob -nocomplain "[homedir]/profiles/*.tcl"] }
		if {![llength $files]} { return "" }
		set norm [string map {" " "" "_" "" "-" ""} [string tolower [string trim $title]]]
		# 1) exact basename (case-insensitive)
		foreach f $files {
			set base [file rootname [file tail $f]]
			if {[string tolower $base] eq [string tolower $title]} { return $base }
		}
		# 2) space/underscore/dash-insensitive, case-insensitive
		foreach f $files {
			set base [file rootname [file tail $f]]
			if {[string map {" " "" "_" "" "-" ""} [string tolower $base]] eq $norm} { return $base }
		}
		# 3) the mangled form filename_from_title would produce (legacy saves)
		set try ""
		catch { set try [::profile::filename_from_title $title] }
		if {$try ne "" && [file exists "[homedir]/profiles/$try.tcl"]} { return $try }
		return ""
	}
}

# Load the questionnaire only if the user is still on a home/brew page. If they
# navigated into Settings/Beans/Profiles in the ~800ms after the shot ended,
# don't yank them off it - just surface the "Rate your shot" chip on home.
proc ::crema::advisor::offer_questionnaire {} {
	set cur ""
	catch { set cur [dui page current] }
	if {[regexp {^(settings_|iconik_settings|crema_beans|crema_dashboard|crema_reconsider|crema_setup|crema_advice|crema_qa)} $cur]} {
		catch { ::crema::pages::crema_home::refresh_pending }
		return
	}
	catch { dui page load crema_qa }
}

# ---- post-shot hook -------------------------------------------------------
# Triggered on the Espresso->Idle state change (instant), NOT on
# after_flow_complete, which lags by after_flow_complete_delay (~5s).
# The shot payload is built at questionnaire SUBMIT time, by which point the
# drip-settle window has long passed.

proc ::crema::after_shot_hook {event_dict} {
	if {[dict get $event_dict previous_state] ne "Espresso"} { return }
	if {[dict get $event_dict this_state] ne "Idle"} { return }
	# the core's legacy shot writer does `range 0 end` on every espresso_*
	# vector; some (e.g. flow_delta_negative) are only appended under
	# non-default settings and stay empty -> "index 0 out of range" dialog.
	# Seed empties before the delayed history save runs.
	catch {
		foreach v [blt::vector names ::espresso_*] {
			catch { if {[$v length] == 0} { $v append 0 } }
		}
	}
	set seconds 0
	catch { set seconds [expr {[lindex [espresso_elapsed range end end] 0]}] }
	if {$seconds ne "" && $seconds < $::crema_settings(min_shot_seconds)} {
		msg -INFO "crema: shot too short (${seconds}s), skipping questionnaire"
		return
	}
	# Freeze the shot NOW so later steam/water can't change its curves, then
	# offer the questionnaire. If auto_qa is off, or the user steams instead,
	# the snapshot waits and home shows a "Rate your shot" prompt (bug #4).
	::crema::advisor::capture_shot
	if {$::crema_settings(auto_qa)} {
		after 800 { catch { ::crema::advisor::offer_questionnaire } }
	} else {
		after 800 { catch { ::crema::pages::crema_home::refresh_pending } }
	}
}

::de1::event::listener::on_major_state_change_add ::crema::after_shot_hook

# Self-heal corrupt profiles at startup. A profile file that got truncated to a
# near-empty size (seen: a 1-byte "Best overall pressure profile.tcl") makes
# de1app flag it "corrupt" and the app chokes/reloads when it's selected. Rather
# than let that crash the user mid-use, quarantine any implausibly-small profile
# (rename to .corrupt.bak) so it drops out of the picker instead of biting.
proc ::crema::quarantine_corrupt_profiles {} {
	set n 0
	catch {
		foreach f [glob -nocomplain "[homedir]/profiles/*.tcl"] {
			if {[catch { set sz [file size $f] }] || $sz >= 50} { continue }
			if {![catch { file rename -force $f "${f}.corrupt.bak" }]} {
				incr n
				msg -INFO "crema: quarantined corrupt profile [file tail $f] (${sz}b)"
			}
		}
	}
	if {$n} { msg -INFO "crema: quarantined $n corrupt profile(s)" }
}
catch { ::crema::quarantine_corrupt_profiles }

# Forensic breadcrumb: log every page change so spontaneous navigation is
# diagnosable from log.txt (cheap, one line per page transition)
catch {
	trace add execution page_display_change enter ::crema::nav_trace
}
# log raw pointer events to tell real taps from phantom ones
catch {
	bind .can <ButtonPress> {+ catch { msg -INFO "crema-touch: down %x %y" } }
}
catch {
	trace add execution ::dui::page::load enter ::crema::nav_trace
}
proc ::crema::nav_trace {cmd op} {
	set who ""
	foreach d {-2 -3 -4} {
		if {![catch { set fr [info frame $d] }]} {
			catch { append who " << [string range [dict get $fr cmd] 0 90]" }
		}
	}
	catch { msg -INFO "crema-nav: [lrange $cmd 0 2] $who" }
}
