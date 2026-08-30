# crema_setup — first-run onboarding wizard (and the AI settings editor).
# Grinder, AI provider, API key, model. Shown automatically on first launch
# when nothing is configured; reachable later from Settings.
#
# Full-bleed layout on the 2560x1600 canvas, using the skin's own theme keys
# and Mazzard type so it matches the rest of Crema (and follows the light/dark
# theme like every other page).

namespace eval ::crema::pages::crema_setup {
	variable widgets; array set widgets {}

	# full-width column: 120px margins like the home page
	variable Lx 120
	variable colW 2320

	variable providers {
		anthropic  "Anthropic (Claude)"
		openai     "OpenAI (GPT)"
		google     "Google (Gemini)"
		compatible "OpenAI-compatible"
		server     "Local Mac server"
	}

	# grid position per provider: {col row span} on a 3-column grid
	variable layout {
		anthropic  {0 0 1}
		openai     {1 0 1}
		google     {2 0 1}
		compatible {0 1 2}
		server     {2 1 1}
	}

	variable help
	array set help {
		anthropic  "Your Anthropic key, from console.anthropic.com - about a cent or two per shot."
		openai     "Your OpenAI key, from platform.openai.com - about a cent or two per shot."
		google     "Google Gemini - has a free tier. Get a key at aistudio.google.com."
		compatible "OpenAI-compatible API: OpenRouter, Groq, DeepSeek, Ollama, LM Studio (local or cheaper)."
		server     "Runs on your own Mac via the Crema server - no per-shot cost, stays on your network."
	}
	variable key_label
	array set key_label {
		anthropic "API KEY"  openai "API KEY"  google "API KEY"
		compatible "API KEY" server "API KEY (not needed)"
	}
	variable url_label
	array set url_label {
		anthropic "BASE URL (optional)"  openai "BASE URL (optional)"  google "BASE URL (optional)"
		compatible "BASE URL"            server "SERVER URL"
	}

	proc pick_provider {p} {
		# Every provider - including "server" - runs the STANDALONE path now, so the
		# Local Mac server rides the same OpenAI-compatible client + LAN auto-discovery
		# as the compatible provider (that's what heals the Mac's IP when it changes).
		set ::crema_settings(ai_mode) standalone
		set ::crema_settings(ai_provider) $p
		if {$p eq "server" && [ifexists ::crema_settings(ai_base_url) ""] eq ""} {
			# seed from any known server URL; discovery fills it in if this is blank
			set ::crema_settings(ai_base_url) [ifexists ::crema_settings(server_url) ""]
		}
		refresh
	}

	proc effective_provider {} {
		if {$::crema_settings(ai_mode) eq "server"} { return server }
		return $::crema_settings(ai_provider)
	}

	# a rounded field background + a borderless entry inset within it
	proc field {page tag fx fy fw fh var {show ""}} {
		dui add shape round $page $fx $fy -bwidth $fw -bheight $fh \
			-fill [::theme card_fill] -radius 18 -tags ${tag}_bg
		set opts [list -canvas_width [expr {$fw - 56}] -font_size 28 \
			-textvariable $var -borderwidth 0 -relief flat \
			-highlightthickness 1 -highlightcolor [::theme accent] \
			-highlightbackground [::theme card_fill] -bg [::theme card_fill] \
			-foreground [::theme background_text] -insertbackground [::theme accent] -tags $tag]
		if {$show ne ""} { lappend opts -show $show }
		dui add entry $page [expr {$fx + 28}] [expr {$fy + ($fh - 46) / 2}] {*}$opts
	}

	proc setup {} {
		set page [namespace tail [namespace current]]
		variable Lx
		variable colW
		set L $Lx
		set R [expr {$L + $colW}]

		dui add dtext $page $L 120 -text "Set up Crema" \
			-font_family "Mazzard SemiBold" -font_size 50 \
			-fill [::theme background_text] -anchor w
		dui add dtext $page $L 205 -text "Two things and you're brewing: your grinder, and how Crema reaches the AI." \
			-font_size 22 -fill [::theme muted] -anchor w

		# ---- grinder (name | espresso dial range) --------------------
		dui add dtext $page $L 320 -text "GRINDER" -font_family "Mazzard Medium" \
			-font_size 16 -fill [::theme muted] -anchor w
		dui add dtext $page 1720 320 -text "ESPRESSO DIAL RANGE (optional)" -font_family "Mazzard Medium" \
			-font_size 16 -fill [::theme muted] -anchor w
		field $page ent_grinder $L 358 1560 100 {::crema_settings(grinder_name)}
		field $page ent_range 1720 358 720 100 {::crema_settings(grinder_range)}
		dui add dtext $page $L 508 -text "Name + your dial range (e.g. 0.4-1.0), so the AI sizes grind moves to your grinder." \
			-font_size 17 -fill [::theme muted] -anchor w -width $colW

		# ---- provider ------------------------------------------------
		dui add dtext $page $L 588 -text "AI PROVIDER" -font_family "Mazzard Medium" \
			-font_size 16 -fill [::theme muted] -anchor w
		variable providers
		variable layout
		set gap 40
		set bw [expr {($colW - $gap) / 2}]     ;# half-width, reused by the URL/MODEL row below
		set u  [expr {($colW - 2 * $gap) / 3}] ;# 3-column unit for the provider grid
		set bh 108
		foreach {key label} $providers {
			lassign [dict get $layout $key] col row span
			set bx [expr {$L + $col * ($u + $gap)}]
			set pw [expr {$span * $u + ($span - 1) * $gap}]
			set by [expr {628 + $row * ($bh + 24)}]
			dui add dbutton $page $bx $by [expr {$bx + $pw}] [expr {$by + $bh}] \
				-tags prov_$key -shape round -radius 32 -fill [::theme button] \
				-label $label -label_pos {0.5 0.5} -label_font_size 25 \
				-label_font_family "Mazzard SemiBold" -label_fill [::theme background_text] \
				-command [list ::crema::pages::crema_setup::pick_provider $key]
		}
		dui add dtext $page $L 920 -text "" -tags setup_help -font_size 19 \
			-fill [::theme muted] -anchor nw -width $colW

		# ---- key -----------------------------------------------------
		dui add dtext $page $L 1010 -text "API KEY" -tags lbl_key \
			-font_family "Mazzard Medium" -font_size 16 -fill [::theme muted] -anchor w
		field $page ent_key $L 1048 [expr {$colW - 150}] 100 {::crema_settings(ai_api_key)} "*"
		# show/hide toggle - a ~100-char key is impossible to proofread masked
		dui add dbutton $page [expr {$L + $colW - 130}] 1048 $R 1148 -tags setup_eye \
			-shape outline -outline [::theme card_outline] -arc_offset 18 -label "Show" \
			-label_pos {0.5 0.5} -label_font_size 20 -label_fill [::theme muted] \
			-command ::crema::pages::crema_setup::toggle_key

		# ---- base url / model row ------------------------------------
		set rx [expr {$L + $bw + $gap}]
		dui add dtext $page $L 1200 -text "BASE URL" -tags lbl_url \
			-font_family "Mazzard Medium" -font_size 16 -fill [::theme muted] -anchor w
		field $page ent_url $L 1238 $bw 100 {::crema_settings(ai_base_url)}
		dui add dtext $page $rx 1200 -text "MODEL (optional)" -tags lbl_model \
			-font_family "Mazzard Medium" -font_size 16 -fill [::theme muted] -anchor w
		field $page ent_model $rx 1238 $bw 100 {::crema_settings(ai_model)}

		# ---- footer --------------------------------------------------
		dui add shape round $page $L 1408 -bwidth $colW -bheight 2 \
			-fill [::theme card_outline] -radius 1 -tags setup_divider
		dui add dtext $page $L 1452 -text "Your shots and taste notes are sent to the AI provider you choose to generate advice. Nothing is shared otherwise - shot history stays on this tablet." \
			-font_size 17 -fill [::theme muted] -anchor nw -width 1240

		# Test result line (blank until tested) + a Test button that checks the
		# key/server BEFORE the user commits and pulls a whole shot on a bad config
		dui add dtext $page 1430 1386 -text "" -tags setup_test_status \
			-font_size 18 -fill [::theme muted] -anchor nw -width 1010

		dui add dbutton $page 1430 1430 1770 1580 -tags setup_test -shape outline \
			-outline [::theme card_outline] -arc_offset 36 -label "Test" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_setup::test

		dui add dbutton $page 1830 1430 $R 1580 -tags setup_done -shape round -radius 36 \
			-fill [::theme accent] -label "Save & continue" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 26 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_setup::done
	}

	proc show {args} { refresh }

	proc refresh {} {
		set page [namespace tail [namespace current]]
		variable providers
		variable help
		variable key_label
		variable url_label
		set eff [effective_provider]
		foreach {key label} $providers {
			set sel [expr {$key eq $eff}]
			catch { dui item config $page prov_$key-btn \
				-fill [expr {$sel ? [::theme accent] : [::theme button]}] }
			catch { dui item config $page prov_$key-lbl \
				-fill [expr {$sel ? [::theme accent_text] : [::theme background_text]}] }
		}
		catch { dui item config $page setup_help -text $help($eff) }
		catch { dui item config $page lbl_key -text $key_label($eff) }
		catch { dui item config $page lbl_url -text $url_label($eff) }
	}

	# reveal / mask the API key so a long pasted key can be proofread
	variable key_shown 0
	proc toggle_key {} {
		variable key_shown
		set key_shown [expr {!$key_shown}]
		set page [namespace tail [namespace current]]
		catch { dui item config $page ent_key -show [expr {$key_shown ? "" : "*"}] }
		catch { dui item config $page setup_eye-lbl -text [expr {$key_shown ? "Hide" : "Show"}] }
	}

	# fire one tiny request to confirm the key/server works, before committing
	proc test {} {
		set page [namespace tail [namespace current]]
		catch { ::save_settings } ; catch { ::crema::save_settings }
		catch { dui item config $page setup_test_status -text "Testing..." -fill [::theme muted] }
		::crema::llm::test_connection [list ::crema::pages::crema_setup::test_done]
	}
	proc test_done {status msg} {
		set page [namespace tail [namespace current]]
		if {$status eq "ok"} {
			catch { dui item config $page setup_test_status \
				-text "✓ Connected - you're good to go." -fill "#57A85A" }
		} else {
			catch { dui item config $page setup_test_status \
				-text "✗ [string range $msg 0 88]" -fill [::theme accent] }
		}
	}

	proc done {} {
		set page [namespace tail [namespace current]]
		set eff [effective_provider]
		# don't let the user "finish" onto a config that can't possibly work -
		# otherwise the first sign of trouble is an error after a whole shot
		if {$eff eq "server"} {
			if {[string trim [ifexists ::crema_settings(ai_base_url) ""]] eq "" && \
					[string trim [ifexists ::crema_settings(server_url) ""]] eq ""} {
				catch { dui item config $page setup_test_status \
					-text "Set the server URL first (or tap Test)." -fill [::theme accent] }
				return
			}
		} elseif {$eff ne "compatible"} {
			if {[string trim [ifexists ::crema_settings(ai_api_key) ""]] eq ""} {
				catch { dui item config $page setup_test_status \
					-text "Enter your API key first (or tap Test)." -fill [::theme accent] }
				return
			}
		}
		# keep server_url in sync with the URL field for the local-server provider
		if {$eff eq "server"} {
			if {[ifexists ::crema_settings(ai_base_url) ""] ne ""} {
				set ::crema_settings(server_url) $::crema_settings(ai_base_url)
			}
		}
		set first [expr {![ifexists ::crema_settings(setup_complete) 0]}]
		catch { ::save_settings }
		::crema::save_settings
		set ::crema_settings(setup_complete) 1
		::crema::save_settings
		catch { ::crema::pages::crema_home::refresh_texts }
		# first-time hand-off: send a brand-new user straight to add their first
		# bean (the actual next step) instead of a home screen that just reads
		# "No bean set". Returning users editing settings just go home.
		set nobean [expr {[string trim [ifexists ::settings(bean_type) ""]] in {"" "New bean" "Unnamed"}}]
		if {$first && $nobean} {
			catch { dui page load crema_beans }
		} else {
			::crema::go_home
		}
	}
}

proc ::crema::pages::setup_init {} {
	dui page add crema_setup -namespace ::crema::pages::crema_setup
}

# true when the app has never been configured for AI
proc ::crema::needs_setup {} {
	if {[ifexists ::crema_settings(setup_complete) 0]} { return 0 }
	set prov [ifexists ::crema_settings(ai_provider) anthropic]
	# the local-server and OpenAI-compatible providers don't need an API key; the
	# LAN discovery + /health check handle reachability, so they're "configured"
	if {$prov in {server compatible} || $::crema_settings(ai_mode) eq "server"} { return 0 }
	return [expr {[ifexists ::crema_settings(ai_api_key) ""] eq ""}]
}
