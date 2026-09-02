# crema_home — the skin's own brew screen (layout per Crema.dc.html design).
# Left: bean block + compact grind card, live metrics row with phase, the
# graph in a bordered card with in-card legend, and an [AI] note strip that
# reopens the advice card. Right: action column. Bottom: nav tabs + advisor
# connection status.

# grinder name for eyebrow labels - falls back to "GRINDER" when unnamed, so a
# blank name never renders an orphaned "GRIND ·" with nothing after it
proc ::crema::grinder_label {} {
	set n [string trim [ifexists ::crema_settings(grinder_name) ""]]
	return [expr {$n eq "" ? "GRINDER" : [string toupper $n]}]
}

namespace eval ::crema::pages::crema_home {
	variable widgets; array set widgets {}
	variable data;    array set data {}
	variable updater ""
	variable health_tick 0

	variable _setup_done 0

	proc setup {} {
		# This page is registered under TWO names ({crema_home crema_off}), and
		# dui::setup_ui calls a page's setup once PER registered name - so setup
		# runs twice and re-adds every tag ("... already exists" error flood). The
		# single run below already tags each item for BOTH names (see $page), so
		# make the second invocation a no-op.
		variable _setup_done
		if {$_setup_done} { return }
		set _setup_done 1
		# tag every item for both registered names of this page
		set page {crema_home crema_off}

		# ---- header --------------------------------------------------
		dui add dtext $page 120 100 -text "Crema" -font_family "Mazzard SemiBold" \
			-font_size 26 -fill [::theme accent] -anchor w
		# a 'variable' item (vs dtext) is load-bearing: pages with zero
		# variable items get no DUI update_vars ticks, and those ticks also
		# drive the desktop simulator's espresso data feed
		dui add variable $page 420 100 -tags home_status -font_size 20 \
			-fill [::theme muted] -anchor w -justify left \
			-textvariable {[::crema::pages::crema_home::status_text]}

		# Connection pills, the pattern OverDose uses. Whether the machine and
		# scale are actually talking is the first thing you want to know and the
		# thing a readout of numbers hides: a stale temperature looks exactly
		# like a live one.
		dui add shape round $page 1700 62 -bwidth 250 -bheight 76 -radius 26 \
			-fill [::theme button] -tags pill_de1_bg
		dui add variable $page 1825 100 -tags pill_de1 -font_size 15 \
			-fill [::theme muted] -anchor center -justify center \
			-textvariable {[::crema::pages::crema_home::pill_text de1]}
		dui add shape round $page 1975 62 -bwidth 250 -bheight 76 -radius 26 \
			-fill [::theme button] -tags pill_scale_bg
		dui add variable $page 2100 100 -tags pill_scale -font_size 15 \
			-fill [::theme muted] -anchor center -justify center \
			-textvariable {[::crema::pages::crema_home::pill_text scale]}
		dui add dbutton $page 2280 50 2460 150 -tags home_sleep -shape outline \
			-outline [::theme card_outline] -arc_offset 30 -label "Sleep" \
			-label_pos {0.5 0.5} -label_font_size 16 -label_fill [::theme muted] \
			-command { start_sleep }

		# ---- bean block ----------------------------------------------
		dui add dtext $page 120 200 -text "BEAN" -font_family "Mazzard Medium" \
			-font_size 15 -fill [::theme muted] -anchor w -tags {home_bean_eyebrow home_bean_tap}
		dui add dtext $page 120 235 -text "" -tags {home_bean home_bean_tap} \
			-font_family "Mazzard SemiBold" -font_size 34 -fill [::theme background_text] \
			-anchor nw -width 1280
		dui add dtext $page 120 330 -text "" -tags {home_bean_sub home_bean_tap} -font_size 17 \
			-fill [::theme muted] -anchor nw -width 1280
		dui add dtext $page 120 380 -text "" -tags {home_recipe home_bean_tap} -font_size 17 \
			-fill [::theme button_text_dark] -anchor nw -width 1280
		dui add dbutton $page 100 180 1420 430 -tags {home_bean_hit home_bean_tap} \
			-fill {} -label "" -command { dui page load crema_beans }

		# ---- compact grind card --------------------------------------
		dui add shape round $page 1470 185 -bwidth 440 -bheight 260 \
			-fill [::theme button] -radius 28 -tags {home_dial_bg home_dial_tap}
		dui add shape outline $page 1470 185 -bwidth 440 -bheight 260 \
			-outline [::theme card_outline] -width 2 -arc_offset 28 -tags home_dial_frame
		dui add dtext $page 1690 230 -text "GRIND" -font_family "Mazzard Medium" \
			-font_size 15 -fill [::theme muted] -anchor center -justify center \
			-tags {home_dial_eyebrow home_dial_tap}
		dui add dtext $page 1690 320 -text "" -tags {home_grind home_dial_tap} \
			-font_family "Mazzard Medium" -font_size 44 -fill [::theme accent] \
			-anchor center -justify center
		dui add dtext $page 1690 400 -text "finer  <     >  coarser" -font_size 12 \
			-fill [::theme muted] -anchor center -justify center \
			-tags {home_dial_hint home_dial_tap}
		dui add dbutton $page 1470 185 1910 445 -tags {home_dial_hit home_dial_tap} \
			-fill {} -label "" -command { dui page load crema_beans }

		# ---- action column -------------------------------------------
		dui add dbutton $page 2080 185 2480 585 -tags home_espresso -shape round \
			-radius 36 -fill [::theme accent] -label "Espresso" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 32 \
			-label_fill [::theme accent_text] \
			-command { ghc_action_or_stop start_espresso }
		dui add dbutton $page 2080 625 2480 880 -tags home_steam -shape round \
			-radius 32 -fill [::theme button] -label "Steam" -label_pos {0.5 0.5} \
			-label_font_size 23 -label_fill [::theme background_text] \
			-command { ghc_action_or_stop start_steam }
		dui add dbutton $page 2080 920 2480 1175 -tags home_water -shape round \
			-radius 32 -fill [::theme button] -label "Water" -label_pos {0.5 0.5} \
			-label_font_size 23 -label_fill [::theme background_text] \
			-command { ghc_action_or_stop start_water }
		dui add dbutton $page 2080 1215 2480 1440 -tags home_flush -shape round \
			-radius 32 -fill [::theme button] -label "Flush" -label_pos {0.5 0.5} \
			-label_font_size 23 -label_fill [::theme background_text] \
			-command { ghc_action_or_stop start_flush }

		# ---- live metrics row (color-keyed to the curves) ------------
		set metrics {
			m_time     TIME           120  {}
			m_pressure "PRESSURE BAR" 450  primary
			m_flow     "FLOW ML/S"    780  secondary
			m_incup    "IN CUP"       1110 weight
		}
		foreach {proc_name label mx theme_key} $metrics {
			set fill [::theme background_text]
			if {$theme_key ne ""} { set fill [::theme $theme_key] }
			dui add dtext $page $mx 495 -text $label -font_family "Mazzard Medium" \
				-font_size 15 -fill [::theme muted] -anchor w
			dui add variable $page $mx 525 -font_family "Mazzard Medium" \
				-font_size 38 -fill $fill -anchor nw \
				-textvariable "\[::crema::pages::crema_home::$proc_name\]"
		}
		dui add dtext $page 1980 495 -text "PHASE" -font_family "Mazzard Medium" \
			-font_size 15 -fill [::theme muted] -anchor ne
		dui add variable $page 1980 535 -font_size 24 -fill [::theme accent] \
			-anchor ne -justify right -width 560 \
			-textvariable {[::crema::pages::crema_home::m_stage]}

		# ---- graph card ----------------------------------------------
		dui add shape round $page 120 630 -bwidth 1860 -bheight 660 \
			-fill [::theme card_fill] -radius 28 -tags home_graph_bg
		dui add shape outline $page 120 630 -bwidth 1860 -bheight 660 \
			-outline [::theme card_outline] -width 2 -arc_offset 28

		add_de1_widget "crema_home crema_off" graph 160 660 {
			$widget axis configure x -color [::theme dim] -tickfont Helv_6
			$widget axis configure y -color [::theme dim] -tickfont Helv_6 -min 0.0 \
				-max 12 -subdivisions 5 -majorticks {0 2 4 6 8 10 12} -hide 0
			$widget grid configure -color [::theme grid_line] -hide no -minor no
			$widget element create line_espresso_pressure_goal -xdata espresso_elapsed \
				-ydata espresso_pressure_goal -symbol none -label "" \
				-linewidth [rescale_x_skin 4] -color [::theme primary_light] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0 -dashes {5 5}
			$widget element create line_espresso_flow_goal -xdata espresso_elapsed \
				-ydata espresso_flow_goal -symbol none -label "" \
				-linewidth [rescale_x_skin 4] -color [::theme secondary_light] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0 -dashes {5 5}
			$widget element create line_espresso_flow_weight -xdata espresso_elapsed \
				-ydata espresso_flow_weight -symbol none -label "" \
				-linewidth [rescale_x_skin 6] -color [::theme weight] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create line_espresso_flow -xdata espresso_elapsed \
				-ydata espresso_flow -symbol none -label "" \
				-linewidth [rescale_x_skin 8] -color [::theme secondary] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create line_espresso_pressure -xdata espresso_elapsed \
				-ydata espresso_pressure -symbol none -label "" \
				-linewidth [rescale_x_skin 8] -color [::theme primary] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
		} -plotbackground [::theme card_fill] -width [rescale_x_skin 1780] \
			-height [rescale_y_skin 540] -borderwidth 0 -background [::theme card_fill] \
			-plotrelief flat -plotpady {14 0} -plotpadx 10

		# in-card legend, swatches matching the curves
		foreach {sx fill label lx} [list \
			200 [::theme primary]   "pressure · bar" 250 \
			560 [::theme secondary] "flow · mL/s"    610 \
			890 [::theme weight]    "weight · g/s"   940 \
		] {
			dui add shape round $page $sx 1238 -bwidth 32 -bheight 9 -radius 4 -fill $fill
			dui add dtext $page $lx 1242 -text $label -font_size 14 \
				-fill [::theme muted] -anchor w
		}
		dui add dtext $page 1220 1242 -text "– –" -font_size 14 \
			-fill [::theme primary] -anchor w
		dui add dtext $page 1270 1242 -text "profile target" -font_size 14 \
			-fill [::theme muted] -anchor w

		# ---- [AI] note strip -----------------------------------------
		dui add dbutton $page 120 1320 1980 1450 -tags home_ai_strip -shape round \
			-radius 28 -fill [::theme button] -label "" \
			-command { dui page load crema_advice }
		dui add shape round $page 160 1355 -bwidth 70 -bheight 56 -radius 14 \
			-fill [::theme accent] -tags {home_ai_badge home_ai_strip}
		dui add dtext $page 195 1383 -text "AI" -font_family "Mazzard SemiBold" \
			-font_size 15 -fill [::theme accent_text] -anchor center -justify center \
			-tags {home_ai_badge_lbl home_ai_strip}
		dui add dtext $page 265 1350 -text "" -tags {home_ai_note home_ai_strip} -font_size 16 \
			-fill [::theme button_text_dark] -anchor nw -width 1480
		dui add dtext $page 1940 1385 -text "Details ›" -font_size 17 \
			-fill [::theme accent] -anchor e -tags {home_ai_details home_ai_strip}

		# tag-level tap bindings: DUI binds presses to item IDs at creation,
		# so items that JOIN a tap tag later need a direct canvas binding
		catch {
			.can bind home_ai_strip [::dui::platform::button_press] \
				{ dui page load crema_advice }
			.can bind home_dial_tap [::dui::platform::button_press] \
				{ dui page load crema_beans }
			.can bind home_bean_tap [::dui::platform::button_press] \
				{ dui page load crema_beans }
		}

		# ---- nav tabs + advisor status -------------------------------
		::crema::pages::add_nav $page brew
		dui add dtext $page 1980 1535 -text "" -tags home_advisor_status \
			-font_size 14 -fill [::theme muted] -anchor e

		# appears while advice is brewing / when it landed / when a shot is
		# waiting to be rated - one slot, its command dispatches on state
		dui add dbutton $page 2080 1480 2480 1580 -tags home_advice_chip \
			-shape round -radius 26 -fill [::theme accent] \
			-label "Advice ready" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 20 \
			-label_fill [::theme accent_text] -initial_state hidden \
			-command ::crema::pages::crema_home::chip_press
	}

	proc chip_press {} {
		if {[::crema::advisor::has_pending] && \
				$::crema::advisor::status ni {sending waiting}} {
			dui page load crema_qa
		} else {
			dui page load crema_advice
		}
	}

	proc refresh_pending {} {
		set page [namespace tail [namespace current]]
		catch { if {[dui page current] in {crema_home crema_off}} { refresh_chip $page } }
	}

	proc refresh_texts {} {
		set page [namespace tail [namespace current]]
		set bean "No bean set - tap to add"
		if {$::settings(bean_type) ne "" || $::settings(bean_brand) ne ""} {
			set bean [string trim "$::settings(bean_type)"]
			if {$bean eq ""} { set bean $::settings(bean_brand) }
		}
		catch { dui item config $page home_bean -text $bean }

		set sub $::settings(bean_brand)
		if {$::settings(roast_date) ne ""} {
			catch {
				set days [expr {([clock seconds] - [clock scan $::settings(roast_date) -format "%Y-%m-%d"]) / 86400}]
				if {$days >= 0 && $days < 400} { append sub "  ·  roasted ${days}d ago" }
			}
		}
		catch { dui item config $page home_bean_sub -text $sub }

		set recipe ""
		catch {
			set target [round_to_integer $::settings(final_desired_shot_weight)]
			if {$::settings(grinder_dose_weight) ni {0 {}} && $target ni {0 {}}} {
				set recipe "$::settings(grinder_dose_weight) g › ${target} g"
				catch {
					set dz $::settings(grinder_dose_weight)
					if {$dz > 0} { append recipe "  ·  1:[format %.1f [expr {$target/double($dz)}]]" }
				}
			}
		}
		catch {
			set pt [ifexists ::settings(profile)]
			if {$pt eq "" || $pt eq "Saved"} { set pt [ifexists ::settings(profile_title)] }
			if {$pt ne ""} {
				if {$recipe ne ""} { append recipe "   ·   " }
				append recipe $pt
			}
		}
		catch { dui item config $page home_recipe -text $recipe }

		catch { dui item config $page home_grind -text $::settings(grinder_setting) }
		catch { dui item config $page home_dial_eyebrow \
			-text "GRIND · [::crema::grinder_label]" }
	}

	proc m_time {} {
		set s 0
		catch { set s [lindex [espresso_elapsed range end end] 0] }
		if {![string is double -strict $s]} { return "0s" }
		return "[format %.0f $s]s"
	}

	proc m_pressure {} {
		set v 0
		catch { set v $::de1(pressure) }
		if {![string is double -strict $v]} { return "-" }
		return [format %.1f $v]
	}

	proc m_flow {} {
		set v 0
		catch { set v $::de1(flow) }
		if {![string is double -strict $v]} { return "-" }
		return [format %.1f $v]
	}

	proc m_incup {} {
		# ONLY ever show the real SCALE weight in grams - the same source as the
		# weight by the timer, so the two always agree. NEVER show pour_volume (the
		# DE1's flow-estimated mL): it prints phantom numbers like "25 mL" when the
		# cup is still empty, which is meaningless noise to the barista. No scale
		# reading yet -> show a dash, not a guess.
		set w ""; catch { set w $::de1(scale_weight) }
		if {[string is double -strict $w] && $w > 0.4 && $w < 200} {
			return "[format %.1f $w] g"
		}
		return "-"
	}

	proc m_stage {} {
		set state ""
		catch { set state [::de1::state::current_state] }
		if {$state ne "Espresso"} { return "" }
		set d ""
		catch { set d $::settings(current_frame_description) }
		return $d
	}

	# The pills say connected or not; the strip beside them says what the
	# numbers are. Colour is set alongside the text because a DUI variable item
	# can only carry the string.
	proc pill_text {which} {
		set page crema_home
		if {$which eq "de1"} {
			set on 0
			catch { set on [expr {[ifexists ::de1(device_handle) 0] != 0}] }
			set label [expr {$on ? "machine" : "no machine"}]
		} else {
			set on 0
			catch { set on [expr {[ifexists ::de1(scale_device_handle) 0] != 0}] }
			set label [expr {$on ? "scale" : "no scale"}]
		}
		catch {
			dui item config $page pill_${which} -fill \
				[expr {$on ? [::theme accent] : [::theme muted]}]
			dui item config $page pill_${which}_bg -fill \
				[expr {$on ? [::theme card_fill] : [::theme button]}]
		}
		return $label
	}

	# One glanceable readout, the thing every good skin has and this one did not:
	# while idle it answers "is the machine ready" without a tap — group and
	# steam temperature, water left, and the scale if one is awake. During a
	# shot it gets out of the way and shows the shot instead.
	#
	# Each value is fetched under its own catch: a DE1 that has not reported
	# steam yet, or a scale that is asleep, must drop that one field rather than
	# blank the whole line.
	proc status_text {} {
		set state "ready"
		catch { set state [::de1::state::current_state] }
		if {$state in {Espresso HotWater Steam HotWaterRinse}} {
			set secs ""
			catch { set secs "[format %.0f [expr {[lindex [espresso_elapsed range end end] 0]}]]s" }
			set w ""
			catch { if {$::de1(scale_weight) > 0.4} { set w "  ·  [format %.1f $::de1(scale_weight)]g" } }
			return "[translate $state]  $secs$w"
		}

		set parts {}

		# Group temperature is the one that says "ready to pull". Below ~80C the
		# machine is still coming up, so say so in words rather than a number
		# nobody has to interpret.
		catch {
			set t $::de1(head_temperature)
			if {[string is double -strict $t] && $t > 0} {
				if {$t < 80} {
					lappend parts "heating [format %.0f $t]°C"
				} else {
					lappend parts "group [format %.1f $t]°C"
				}
			}
		}
		catch {
			set t $::de1(steam_heater_temperature)
			if {[string is double -strict $t] && $t > 0} { lappend parts "steam [format %.0f $t]°C" }
		}
		catch {
			set ml [water_tank_level_to_milliliters $::de1(water_level)]
			if {[string is double -strict $ml]} { lappend parts "water [format %.0f $ml] mL" }
		}
		# Only when a scale is actually reporting; a dead scale should leave no
		# trace rather than sit at a permanent 0.0g.
		catch {
			set w $::de1(scale_weight)
			if {[string is double -strict $w] && $w > 0.4} { lappend parts "scale [format %.1f $w]g" }
		}

		if {![llength $parts]} { return "" }
		return [join $parts "  ·  "]
	}

	# advisor states -> one chip: quiet while thinking, accent when ready
	proc refresh_chip {page} {
		set status $::crema::advisor::status
		set seen $::crema::advisor::advice_seen
		# a shot waiting to be rated outranks everything except an in-flight ask
		if {[::crema::advisor::has_pending] && $status ni {sending waiting}} {
			dui item config $page home_advice_chip-btn -fill [::theme accent]
			dui item config $page home_advice_chip-lbl -text "Rate your shot" \
				-fill [::theme accent_text]
			dui item config $page home_advice_chip* -state normal
		} elseif {$status in {sending waiting}} {
			dui item config $page home_advice_chip-btn -fill [::theme button]
			dui item config $page home_advice_chip-lbl -text "Asking the AI..." \
				-fill [::theme muted]
			dui item config $page home_advice_chip* -state normal
		} elseif {$status eq "done" && !$seen} {
			dui item config $page home_advice_chip-btn -fill [::theme accent]
			dui item config $page home_advice_chip-lbl -text "Advice ready" \
				-fill [::theme accent_text]
			dui item config $page home_advice_chip* -state normal
		} elseif {$status eq "error" && !$seen} {
			dui item config $page home_advice_chip-btn -fill [::theme button]
			dui item config $page home_advice_chip-lbl -text "Advice failed" \
				-fill [::theme muted]
			dui item config $page home_advice_chip* -state normal
		} else {
			dui item config $page home_advice_chip* -state hidden
		}
	}

	proc refresh_status {} {
		variable updater
		variable health_tick
		set page [namespace tail [namespace current]]
		set state "ready"
		catch { set state [::de1::state::current_state] }
		set flowing [expr {$state in {Espresso HotWater Steam HotWaterRinse}}]
		catch { dui item config $page home_status \
			-fill [expr {$flowing ? [::theme accent] : [::theme muted]}] }
		catch { dui item config $page home_espresso-lbl \
			-text [expr {$state eq "Espresso" ? "Stop" : "Espresso"}] }
		catch {
			if {[dui page current] in {crema_home crema_off}} {
				refresh_chip $page
			}
		}
		if {[incr health_tick] % 30 == 1} { ping_advisor }
		set updater [after 1000 ::crema::pages::crema_home::refresh_status]
	}

	proc ping_advisor {} {
		# standalone talks straight to the AI provider — there's no server to
		# ping, so the status reflects whether an API key has been set instead
		if {[::crema::advisor::standalone]} {
			set_advisor_status [::crema::llm::configured]
			return
		}
		if {[catch {
			::http::geturl "$::crema_settings(server_url)/health" -timeout 4000 \
				-command ::crema::pages::crema_home::ping_done
		}]} { set_advisor_status 0 }
	}

	proc ping_done {token} {
		set ok 0
		catch {
			set ncode [::http::ncode $token]
			if {$ncode == 200} { set ok 1 }
		}
		catch { ::http::cleanup $token }
		set_advisor_status $ok
	}

	proc set_advisor_status {ok} {
		set page [namespace tail [namespace current]]
		if {[::crema::advisor::standalone]} {
			set txt [expr {$ok ? "AI ready" : "Add your AI key in Settings"}]
		} else {
			set txt [expr {$ok ? "Advisor connected" : "Advisor offline"}]
		}
		catch { dui item config $page home_advisor_status \
			-text $txt \
			-fill [expr {$ok ? [::theme muted] : [::theme accent]}] }
	}

	proc show {args} {
		variable updater
		# keep bean_sel / last_grind aligned with the live bean before anything
		# reads them (prevents the bean_sel<->bean_type desync that could clone a
		# bean over another on the next beans-page save)
		catch { ::crema::pages::crema_beans::reconcile }
		catch { ::crema::advisor::ensure_bean_profile }
		refresh_texts
		after cancel $updater
		refresh_status
		refresh_ai_note
	}

	# the strip shows the freshest advice: local advisor state when we have
	# it (updates the instant advice lands), otherwise the server's last shot
	proc refresh_ai_note {} {
		set page [namespace tail [namespace current]]
		# trust the in-memory advice only when it belongs to the CURRENTLY loaded
		# bean - otherwise it's a different bean's advice and we must fetch fresh
		set cur [string trim [ifexists ::settings(bean_type) ""]]
		set adv_bean ""
		catch { set adv_bean [ifexists ::crema::advisor::advice_bean ""] }
		if {$::crema::advisor::status eq "done" && ($adv_bean eq "" || $adv_bean eq $cur)} {
			set note ""
			catch { set note $::crema::advisor::advice(summary) }
			if {$note ne ""} {
				catch { dui item config $page home_ai_note \
					-text [::crema::trim_words $note 168] }
				return
			}
		}
		fetch_last_shot
	}

	proc hide {args} {
		variable updater
		after cancel $updater
	}

	proc fetch_last_shot {} {
		# scope to the loaded bean so the strip shows THIS bean's last advice.
		# Pull several (not just the newest) so a recent un-advised shot doesn't
		# hide the last real advice for this bean.
		set bean [string trim [ifexists ::settings(bean_type) ""]]
		::crema::history::recent 8 ::crema::pages::crema_home::last_shot_loaded $bean
	}

	proc last_shot_loaded {shots} {
		set page [namespace tail [namespace current]]
		if {[catch {
			if {![llength $shots]} {
				catch { dui item config $page home_ai_note \
					-text "New bean — tap for an AI starting point, then pull your first shot." }
				return
			}
			# newest shot FIRST that actually carries advice (skip Save-only / failed ones)
			set note ""
			foreach s $shots {
				set adv ""
				catch { set adv [dict get $s advice] }
				if {$adv ne "" && $adv ne "null"} {
					catch { set note [dict get $adv screen_summary] }
					if {$note ne ""} break
				}
			}
			if {$note eq ""} { set note "Pull a shot and tap 'Get advice' — dial-in tips land here." }
			set note [::crema::trim_words $note 168]
			catch { dui item config $page home_ai_note -text $note }
		} err]} { }
	}
}

# ---- take over navigation ------------------------------------------------
proc ::crema::go_home {} {
	catch { dui page load crema_home }
}

proc iconik_wakeup {} {
	if {[::crema::needs_setup]} {
		dui page load crema_setup
	} else {
		dui page load crema_home
	}
	start_idle
}

proc iconik_home {} {
	# first run (no provider configured yet) routes the idle/off screen to the
	# setup wizard so a fresh install can't land on a home page it can't use
	if {[::crema::needs_setup]} {
		::page_to_show_when_off "crema_setup"
	} else {
		::page_to_show_when_off "crema_home"
	}
	restore_espresso_chart
}

proc skins_page_change_due_to_de1_state_change { textstate } {
	if {$textstate == "Idle"} {
		# late/duplicate Idle state packets must not yank the user off a
		# page they are reading - only leave flow/system pages
		set cur ""
		catch { set cur [dui page current] }
		if {[string match crema_* $cur] || [string match settings_* $cur] \
				|| $cur in {iconik_settings}} {
			return
		}
		page_display_change $::de1(current_context) "crema_home"
	} elseif {$textstate == "Sleep"} {
		page_display_change $::de1(current_context) "saver"
	} elseif {$textstate == "Refill"} {
		page_display_change $::de1(current_context) "tankempty"
	} elseif {$textstate == "Descale"} {
		page_display_change $::de1(current_context) "descaling"
	} elseif {$textstate == "Clean"} {
		page_display_change $::de1(current_context) "cleaning"
	} elseif {$textstate == "AirPurge"} {
		page_display_change $::de1(current_context) "travel_do"
	}
}

proc ::crema::pages::home_init {} {
	# registered under BOTH names: "crema_off" so every MimojaCafe reference
	# to "$::iconik_settings(ui)_off" (settings Done buttons, wakeup, state
	# changes) lands on OUR home, not default_off
	dui page add {crema_home crema_off} -namespace ::crema::pages::crema_home
	set ::iconik_settings(ui) "crema"
}
