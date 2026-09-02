# Crema AI pages: post-shot questionnaire, advice card, bean & grind card.
# All DUI pages on the 2560x1600 reference canvas, styled by the skin theme.

namespace eval ::crema::pages {}

# Shared bottom tab bar (design: persistent nav on every screen).
# active: which tab gets the accent + underline. prenav: script run before
# navigating away (e.g. beans saves its fields).
proc ::crema::pages::add_nav {page active {prenav {}}} {
	set tabs {
		brew     "Brew"          120  90  { ::crema::go_home }
		shots    "Shots"         320  95  { dui page load crema_dashboard }
		beans    "Beans & grind" 600  225 { dui page load crema_beans }
		profiles "Profiles"      1040 135 { ::page_to_show_when_off "settings_1" ; after 250 { catch { fill_profiles_listbox ; set_profiles_scrollbar_dimensions } } }
		settings "Settings"      1340 140 { ::page_to_show_when_off "iconik_settings" }
	}
	foreach {key label nx w cmd} $tabs {
		if {$key eq $active} {
			dui add dtext $page $nx 1530 -text $label -font_family "Mazzard SemiBold" \
				-font_size 19 -fill [::theme accent] -anchor w
			dui add shape round $page $nx 1562 -bwidth $w -bheight 6 -radius 3 \
				-fill [::theme accent]
		} else {
			set full $cmd
			if {$prenav ne ""} { set full "catch { $prenav }\n$cmd" }
			dui add dbutton $page $nx 1490 [expr {$nx + $w + 110}] 1585 \
				-tags nav_${key} -fill {} -label $label -label_pos {0 0.5} \
				-label_anchor w -label_font_size 19 -label_fill [::theme muted] \
				-command $full
		}
	}
}

# ---------------------------------------------------------------------------
# crema_qa — "How was that shot?" (4 quick rows, <10s to answer)
# ---------------------------------------------------------------------------
namespace eval ::crema::pages::crema_qa {
	variable widgets;  array set widgets {}
	variable data
	array set data {taste "" body "" flow "" aftertaste "" enjoyment ""}

	variable groups
	set groups {
		taste     {sour "Sour" salty "Salty" balanced "Balanced" bitter "Bitter" harsh "Harsh"}
		body      {thin "Thin" good "Good" heavy "Heavy"}
		flow      {even "Even" spritzy "Spritzy" gushed "Gushed" choked "Choked"}
		aftertaste {clean "Clean" short "Short" lingering "Lingering" astringent "Dry/astringent"}
		enjoyment {1 "1" 2 "2" 3 "3" 4 "4" 5 "5"}
	}

	proc pick {group value} {
		variable data
		set data($group) $value
		refresh_marks
	}

	# Correct the grind you ACTUALLY used before submitting - the app's tracked
	# number can drift from your grinder, and the advisor reasons from this value.
	proc bump_grind {delta} {
		set cur [current_grind]
		if {![string is double -strict $cur]} { set cur 0 }
		set_grind [::crema::snap_grind [expr {$cur + $delta}]]
	}

	# The grind to SHOW/use: prefer Crema's own remembered value (last_grind),
	# which survives across sessions in the homedir store. ::settings(grinder_setting)
	# can silently revert between shots (app restart, a flaky settings.tdb save, or
	# a profile that carries its own grind), which is why the feedback page kept
	# showing an old number the user had to re-fix every time.
	proc current_grind {} {
		set lg [ifexists ::crema_settings(last_grind) ""]
		if {[string is double -strict $lg] && $lg > 0} { return $lg }
		return $::settings(grinder_setting)
	}

	# Set the grind everywhere at once: the live de1app setting, Crema's durable
	# memory, and the frozen shot record the AI reasons from - then repaint.
	proc set_grind {val} {
		if {![string is double -strict $val]} { return }
		set ::settings(grinder_setting) $val
		set ::crema_settings(last_grind) $val
		catch { ::save_settings }
		catch { ::crema::save_settings }
		catch {
			if {$::crema::advisor::pending_record ne ""} {
				dict set ::crema::advisor::pending_record grinder_setting $val
				dict set ::crema::advisor::pending_record grinder setting $val
			}
		}
		refresh_grind
	}

	proc refresh_grind {} {
		set page [namespace tail [namespace current]]
		catch { dui item config $page qa_grind -text [current_grind] }
	}

	proc refresh_marks {} {
		variable data
		variable groups
		set page [namespace tail [namespace current]]
		foreach {group options} $groups {
			foreach {value label} $options {
				set tag opt_${group}_${value}
				if {$data($group) eq $value} {
					catch { dui item config $page ${tag}-btn -fill [::theme accent] }
					catch { dui item config $page ${tag}-lbl -fill [::theme accent_text] }
				} else {
					catch { dui item config $page ${tag}-btn -fill [::theme button] }
					catch { dui item config $page ${tag}-lbl -fill [::theme button_text_dark] }
				}
			}
		}
	}

	proc submit {} {
		variable data
		# an all-blank rating gives the AI nothing to reason from - nudge instead
		if {$data(taste) eq "" && $data(body) eq "" && $data(flow) eq "" \
				&& $data(aftertaste) eq "" && $data(enjoyment) eq ""} {
			set page [namespace tail [namespace current]]
			catch { dui item config $page qa_saved_msg \
				-text "Tell the AI how it tasted first — pick at least a score." -fill [::theme accent] }
			return
		}
		set answers [list \
			taste_balance $data(taste) \
			body $data(body) \
			flow_look $data(flow) \
			aftertaste $data(aftertaste) \
			enjoyment $data(enjoyment) \
			grinder_setting_now [current_grind]]
		# Land on the ADVICE page in its "AI is working..." state, then fire the
		# request on a short delay (the network call blocks the event loop, so an
		# inline send would freeze with no feedback). The advice page auto-updates
		# to the verdict when it lands (advisor::update_advice_page -> refresh); the
		# barista can also head home, where the chip turns tan when it's ready.
		set ::crema::advisor::status "waiting"
		set ::crema::advisor::advice_seen 0
		catch { dui page load crema_advice }
		catch { ::crema::pages::crema_home::refresh_pending }
		catch { update }
		after 250 [list ::crema::pages::crema_qa::send_now $answers]
	}

	proc send_now {answers} {
		::crema::advisor::send_shot $answers
		::crema::advisor::clear_pending
		catch { ::crema::pages::crema_home::refresh_pending }
	}

	# save the rating to history but do NOT call the AI - just log the shot
	proc save_only {} {
		variable data
		set answers [list \
			taste_balance $data(taste) \
			body $data(body) \
			flow_look $data(flow) \
			aftertaste $data(aftertaste) \
			enjoyment $data(enjoyment) \
			grinder_setting_now [current_grind]]
		::crema::advisor::save_rating_only $answers
		catch { ::crema::pages::crema_home::refresh_pending }
		# acknowledge the save on-screen, then drop home after a beat
		set page [namespace tail [namespace current]]
		catch { dui item config $page qa_saved_msg -text "✓ Shot saved to history" -fill "#57A85A" }
		after 900 { catch { ::crema::pages::crema_qa::_finish_save } }
	}
	proc _finish_save {} {
		set page [namespace tail [namespace current]]
		catch { dui item config $page qa_saved_msg -text "" }
		::crema::go_home
	}

	# keep the frozen shot; home shows a "Rate your shot" prompt to finish later
	proc later {} {
		catch { ::crema::pages::crema_home::refresh_pending }
		::crema::go_home
	}

	# discard this shot's rating entirely
	proc skip {} {
		::crema::advisor::clear_pending
		catch { ::crema::pages::crema_home::refresh_pending }
		::crema::go_home
	}

	proc row {page y title group options} {
		dui add dtext $page 160 [expr {$y + 42}] -text [string toupper $title] \
			-font_family "Mazzard Medium" -font_size 15 -fill [::theme muted] \
			-anchor w -tags lbl_$group
		set n [llength $options]
		set x 640
		foreach {value label} $options {
			set w [expr {$n >= 5 ? 300 : ($n == 4 ? 380 : 480)}]
			dui add dbutton $page $x $y [expr {$x + $w}] [expr {$y + 108}] \
				-tags opt_${group}_${value} -shape round -radius 22 \
				-fill [::theme button] -label $label -label_pos {0.5 0.5} \
				-label_font_size 20 -label_fill [::theme button_text_dark] \
				-command [list ::crema::pages::crema_qa::pick $group $value]
			incr x [expr {$w + 30}]
		}
	}

	proc setup {} {
		variable groups
		set page [namespace tail [namespace current]]

		dui add dtext $page 160 90 -text "How was that shot?" \
			-font_family "Mazzard SemiBold" -font_size 38 \
			-fill [::theme background_text] -anchor w -tags qa_title
		dui add dtext $page 160 165 -text "" -tags qa_summary \
			-font_size 17 -fill [::theme muted] -anchor w

		# confirm the grind you actually used (the AI reasons from this)
		dui add dtext $page 1620 108 -text "GRIND USED" -font_family "Mazzard Medium" \
			-font_size 15 -fill [::theme muted] -anchor w
		dui add dtext $page 1930 100 -text "" -tags qa_grind \
			-font_family "Mazzard SemiBold" -font_size 32 -fill [::theme accent] -anchor w
		dui add dbutton $page 2130 68 2270 158 -tags qa_gminus -shape round -radius 20 \
			-fill [::theme button] -label "-0.05" -label_pos {0.5 0.5} -label_font_size 18 \
			-label_fill [::theme background_text] \
			-command [list ::crema::pages::crema_qa::bump_grind -0.05]
		dui add dbutton $page 2290 68 2430 158 -tags qa_gplus -shape round -radius 20 \
			-fill [::theme button] -label "+0.05" -label_pos {0.5 0.5} -label_font_size 18 \
			-label_fill [::theme background_text] \
			-command [list ::crema::pages::crema_qa::bump_grind 0.05]

		set y 250
		foreach {group options} $groups {
			set title [string totitle $group]
			if {$group eq "flow"} { set title "Flow looked" }
			if {$group eq "aftertaste"} { set title "Finish" }
			if {$group eq "enjoyment"} { set title "Enjoyment" }
			row $page $y $title $group $options
			incr y 178
		}

		# Three clear outcomes, left to right by weight: DISCARD (throw the shot
		# away) - SAVE ONLY (log it + rating, no AI) - GET ADVICE (log + AI). We
		# dropped the old "Rate later": leaving this page via the nav bar already
		# keeps the shot pending, and home surfaces it as a "Rate your shot" chip.
		# "Skip" was renamed "Discard" because users read Skip as "keep the shot".
		dui add dbutton $page 160 1300 680 1420 -tags qa_skip -shape outline \
			-outline [::theme card_outline] -arc_offset 32 -label "Discard" \
			-label_pos {0.5 0.5} -label_font_size 20 -label_fill [::theme muted] \
			-command ::crema::pages::crema_qa::skip

		# save the rating to history WITHOUT calling the AI (no wait, no LLM cost)
		dui add dbutton $page 1020 1300 1540 1420 -tags qa_saveonly -shape outline \
			-outline [::theme card_outline] -arc_offset 32 -label "Save only" \
			-label_pos {0.5 0.5} -label_font_size 20 -label_fill [::theme background_text] \
			-command ::crema::pages::crema_qa::save_only

		dui add dbutton $page 1880 1300 2400 1420 -tags qa_submit -shape round -radius 32 \
			-fill [::theme accent] -label "Get advice" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 22 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_qa::submit

		# brief confirmation shown after "Save only" before we drop back home
		dui add dtext $page 1280 1240 -text "" -tags qa_saved_msg -font_size 24 \
			-fill "#57A85A" -anchor center -justify center

		::crema::pages::add_nav $page {}
	}

	proc show {args} {
		variable data
		array set data {taste "" body "" flow "" aftertaste "" enjoyment ""}
		refresh_marks
		set page [namespace tail [namespace current]]
		set parts {}
		catch {
			set secs [lindex [espresso_elapsed range end end] 0]
			if {[string is double -strict $secs] && $secs > 0} {
				lappend parts "[format %.0f $secs]s"
			}
		}
		catch {
			set w $::de1(scale_weight)
			if {[string is double -strict $w] && $w > 0.4} {
				lappend parts "[format %.1f $w] g in cup"
			}
		}
		lappend parts "a few taps, the AI does the rest"
		catch { dui item config $page qa_summary -text [join $parts "  ·  "] }
		# adopt Crema's remembered grind so the page opens on the grind you last
		# used (not a reverted setting), and the shot record matches it up front
		catch { set_grind [current_grind] }
		refresh_grind
	}
}

# ---------------------------------------------------------------------------
# crema_advice — the AI's verdict + one-tap apply
# ---------------------------------------------------------------------------
namespace eval ::crema::pages::crema_advice {
	variable widgets; array set widgets {}
	variable data;    array set data {}
	variable primary_mode "done"

	proc setup {} {
		set page [namespace tail [namespace current]]

		dui add dtext $page 120 100 -text "Dial-in advice" \
			-font_family "Mazzard SemiBold" -font_size 34 \
			-fill [::theme background_text] -anchor w -tags adv_title
		dui add dtext $page 760 118 -text "" -tags adv_status -font_size 17 \
			-fill [::theme muted] -anchor w -width 1660

		# verdict hero + kicker
		dui add dtext $page 120 330 -text "" -tags adv_grind_hero \
			-font_family "Mazzard Light" -font_size 92 -fill [::theme accent] \
			-anchor w
		dui add dtext $page 124 490 -text "" -tags adv_grind_sub \
			-font_family "Mazzard Medium" -font_size 15 -fill [::theme muted] -anchor w

		dui add dtext $page 120 530 -text "" -tags adv_summary \
			-font_size 29 -fill [::theme background_text] -anchor nw -justify left -width 2240

		# action chips
		for {set i 0} {$i < 5} {incr i} {
			set x [expr {120 + $i * 470}]
			dui add shape round $page $x 800 -bwidth 440 -bheight 140 \
				-fill [::theme button] -radius 20 -tags achip_${i}_bg \
				-initial_state hidden
			dui add dtext $page [expr {$x + 30}] 832 -text "" -tags achip_${i}_key \
				-font_family "Mazzard Medium" -font_size 12 -fill [::theme muted] -anchor w
			dui add dtext $page [expr {$x + 30}] 888 -text "" -tags achip_${i}_val \
				-font_family "Mazzard Medium" -font_size 22 -fill [::theme accent] -anchor w \
				-width 380
		}

		# WHY card
		dui add shape outline $page 120 980 -bwidth 2320 -bheight 290 \
			-outline [::theme card_outline] -width 2 -arc_offset 24 -tags adv_why_frame \
			-initial_state hidden
		dui add dtext $page 1280 700 -text "" -tags adv_wait -font_size 26 \
			-fill [::theme muted] -anchor center -justify center -width 1700
		dui add dtext $page 160 1020 -text "WHY" -font_family "Mazzard Medium" \
			-font_size 12 -fill [::theme muted] -anchor w -tags adv_why_lbl \
			-initial_state hidden
		dui add dtext $page 280 1010 -text "" -tags adv_why -font_size 16 \
			-fill [::theme button_text_dark] -anchor nw -justify left -width 2120

		dui add dbutton $page 120 1300 640 1440 -tags adv_apply_all -shape round -radius 32 \
			-initial_state hidden -fill [::theme accent] -label "Got it" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_advice::primary_press

		# Undo sits beside Apply and appears only once Apply has run. It shares no
		# slot with adv_fixsetup, which only exists in the error state.
		dui add dbutton $page 680 1300 1200 1440 -tags adv_undo -shape round -radius 32 \
			-initial_state hidden -fill [::theme card] -label "Undo" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme button_text_dark] \
			-command ::crema::pages::crema_advice::undo_press

		# shown only in the error state (same slot as Apply, never both at once)
		dui add dbutton $page 120 1300 640 1440 -tags adv_retry -shape round -radius 32 \
			-initial_state hidden -fill [::theme accent] -label "Try again" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme accent_text] \
			-command ::crema::advisor::retry

		# error state only: jump straight to the AI setup wizard - a bad/missing key
		# or unreachable server is the usual cause, and hunting through Settings for
		# it is a two-hop maze
		dui add dbutton $page 680 1300 1200 1440 -tags adv_fixsetup -shape outline \
			-initial_state hidden -outline [::theme card_outline] -arc_offset 32 \
			-label "Fix AI setup" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_advice::open_setup

		# shown only for a bean with NO shots yet: ask the AI for a starting point
		dui add dbutton $page 120 1300 760 1440 -tags adv_starter -shape round -radius 32 \
			-initial_state hidden -fill [::theme accent] -label "Get a starting point" \
			-label_pos {0.5 0.5} -label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme accent_text] \
			-command ::crema::advisor::request_starter

		dui add dbutton $page 1980 1300 2400 1440 -tags adv_done -shape outline \
			-outline [::theme card_outline] -arc_offset 32 -label "Done" \
			-label_pos {0.5 0.5} -label_font_family "Mazzard SemiBold" \
			-label_font_size 24 -label_fill [::theme background_text] \
			-command ::crema::pages::crema_advice::done

		::crema::pages::add_nav $page {}
	}

	proc show {args} {
		# only mark seen when there is real advice on screen - peeking at the
		# waiting page must not swallow the "Advice ready" chip
		if {$::crema::advisor::status eq "done"} { ::crema::advisor::mark_seen }
		refresh
		if {$::crema::advisor::status ni {done sending waiting error}} {
			::crema::advisor::hydrate_from_server
		}
	}

	# dui item show/hide no-op during page transitions (they check the current
	# page); config -state on both the shape and its -lbl item is unconditional
	proc setvis {page tag visible} {
		set st [expr {$visible ? "normal" : "hidden"}]
		# every dbutton subitem (shape -btn, label -lbl, click rect) carries
		# the literal tag "<tag>*"
		catch { dui item config $page ${tag}* -state $st }
	}

	proc setlabel {page tag text} {
		catch { dui item config $page ${tag}-lbl -text $text }
	}

	proc set_chip {i key val} {
		set page [namespace tail [namespace current]]
		if {$key eq ""} {
			catch { dui item config $page achip_${i}_bg* -state hidden }
			catch { dui item config $page achip_${i}_key -state hidden }
			catch { dui item config $page achip_${i}_val -state hidden }
			return
		}
		catch { dui item config $page achip_${i}_bg* -state normal }
		catch { dui item config $page achip_${i}_key -state normal -text $key }
		catch { dui item config $page achip_${i}_val -state normal -text $val }
	}

	proc show_skeleton {page visible} {
		set st [expr {$visible ? "normal" : "hidden"}]
		catch { dui item config $page adv_why_frame* -state $st }
		catch { dui item config $page adv_why_lbl -state $st }
		if {!$visible} {
			for {set i 0} {$i < 5} {incr i} { set_chip $i "" "" }
		}
	}

	proc refresh {} {
		variable primary_mode
		set page [namespace tail [namespace current]]
		set status $::crema::advisor::status

		setvis $page adv_apply_all 0
		catch { setvis $page adv_undo 0 }
		setvis $page adv_retry 0
		setvis $page adv_fixsetup 0
		setvis $page adv_starter 0

		if {$status ne "done"} {
			show_skeleton $page 0
			foreach t {adv_grind_hero adv_grind_sub adv_summary adv_why adv_status} {
				catch { dui item config $page $t -text "" }
			}
		}
		if {$status eq "empty"} {
			if {[ifexists ::crema::advisor::advice_has_shots 0]} {
				# bean HAS shots, just none with AI advice yet (saved without advice)
				dui item config $page adv_wait \
					-text "No AI advice saved for this bean yet.\nPull a shot and tap 'Get advice' - your dial-in tips land here."
			} else {
				# brand-new bean, never pulled - offer an AI starting point
				dui item config $page adv_wait \
					-text "No shots yet for this bean.\nGet an AI starting point - profile, grind, dose, ratio and temp - to pull your first shot from."
			}
			setvis $page adv_starter 1
		} elseif {$status ni {done sending waiting error}} {
			dui item config $page adv_wait -text "Loading last advice..."
		} elseif {$status eq "sending"} {
			dui item config $page adv_wait -text "Sending your shot..."
		} elseif {$status eq "waiting"} {
			dui item config $page adv_wait \
				-text "The AI is working on it — usually 15–60 seconds.\n\nYour advice will appear right here automatically. You don't need to tap anything.\n\n(You can leave; it'll be waiting for you on the home screen.)"
		} elseif {$status eq "error"} {
			set err ""
			catch { set err $::crema::advisor::advice(error) }
			dui item config $page adv_wait -text "Couldn't get advice.\n$err\n\nYour shot is saved. Tap Try again, or Fix AI setup."
			setvis $page adv_retry 1
			setvis $page adv_fixsetup 1
		} elseif {$status eq "done"} {
			::crema::advisor::mark_seen
			dui item config $page adv_wait -text ""
			show_skeleton $page 1
			dui item config $page adv_status \
				-text "Confidence [string tolower $::crema::advisor::advice(confidence)]"
			dui item config $page adv_summary -text $::crema::advisor::advice(summary)

			set a ::crema::advisor::advice
			set cur $::settings(grinder_setting)
			set target [set ${a}(grind_target)]
			set grind_changes [expr {$target ne "" && $target != $cur}]
			set has_profile [expr {[set ${a}(created_profile)] ne "" || \
				([set ${a}(profile_action)] eq "switch" && [set ${a}(profile_switch_to)] ni {"" null})}]
			set temp [set ${a}(temp_c)]
			set dose [set ${a}(dose_g)]
			set yield [set ${a}(yield_g)]
			set has_temp  [expr {$temp ne "" && $temp != $::settings(espresso_temperature)}]
			set has_dose  [expr {$dose ne "" && $dose != $::settings(grinder_dose_weight)}]
			set has_yield [expr {$yield ne "" && $yield != $::settings(final_desired_shot_weight)}]

			# verdict hero
			if {$grind_changes} {
				set word [expr {$target < $cur ? "finer" : "coarser"}]
				dui item config $page adv_grind_hero -text "$word  $target"
				dui item config $page adv_grind_sub -text "GRIND · $cur › $target · [::crema::grinder_label]"
			} elseif {[set ${a}(created_profile)] ne ""} {
				dui item config $page adv_grind_hero -text "new profile"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			} elseif {[set ${a}(profile_action)] eq "switch" && [set ${a}(profile_switch_to)] ni {"" null}} {
				dui item config $page adv_grind_hero -text "switch profile"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			} elseif {$has_temp} {
				set word [expr {$temp > $::settings(espresso_temperature) ? "hotter" : "cooler"}]
				dui item config $page adv_grind_hero -text "$word  ${temp}C"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			} elseif {$has_yield} {
				dui item config $page adv_grind_hero -text "yield  ${yield}g"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			} elseif {$has_dose} {
				dui item config $page adv_grind_hero -text "dose  ${dose}g"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			} else {
				dui item config $page adv_grind_hero -text "keep  $cur"
				dui item config $page adv_grind_sub -text "GRIND · NO CHANGE YET"
			}

			# action chips
			set chips {}
			if {$grind_changes} {
				lappend chips "GRIND" "$cur › $target"
			} else {
				lappend chips "GRIND" "keep $cur"
			}
			if {$has_temp}  { lappend chips "TEMP" "$::settings(espresso_temperature) › ${temp}C" }
			if {$has_dose}  { lappend chips "DOSE" "$::settings(grinder_dose_weight) › ${dose} g" }
			if {$has_yield} { lappend chips "YIELD" "› ${yield} g" }
			if {[set ${a}(created_profile)] ne ""} {
				lappend chips "PROFILE" "new profile"
			} elseif {[set ${a}(profile_action)] eq "switch" && [set ${a}(profile_switch_to)] ni {"" null}} {
				lappend chips "PROFILE" "→ [::crema::trim_words [set ${a}(profile_switch_to)] 13]"
			} else {
				lappend chips "PROFILE" "unchanged"
			}
			set i 0
			foreach {k v} $chips {
				if {$i > 4} { break }
				set_chip $i $k [::crema::trim_words $v 24]
				incr i
			}
			for {} {$i < 5} {incr i} { set_chip $i "" "" }

			set why ""
			catch { set why $::crema::advisor::advice(diagnosis) }
			if {[string length $why] > 460} { set why "[string range $why 0 457]..." }
			dui item config $page adv_why -text $why

			if {$grind_changes || $has_temp || $has_dose || $has_yield || $has_profile} {
				set primary_mode "apply"
				setlabel $page adv_apply_all "Apply"
			} else {
				set primary_mode "done"
				setlabel $page adv_apply_all "Got it"
			}
			setvis $page adv_apply_all 1
		}
	}

	proc primary_press {} {
		variable primary_mode
		if {$primary_mode eq "apply"} {
			apply_all
		} else {
			done
		}
	}

	# Put the machine back where it was before Apply. One-shot: the button hides
	# itself again so a second press cannot re-apply a stale snapshot over
	# something changed by hand since.
	proc undo_press {} {
		set page [namespace tail [namespace current]]
		if {[catch { ::crema::advisor::undo_last_apply } ok]} {
			msg -ERROR "crema: undo failed: $ok"
			catch { dui item config $page adv_status -text "Undo failed - see the log" }
			return
		}
		catch { setvis $page adv_undo 0 }
		variable primary_mode
		set primary_mode "apply"
		catch { setlabel $page adv_apply_all "Apply" }
		catch { dui item config $page adv_status \
			-text [expr {$ok ? {Undone - back to your previous settings} : {Nothing to undo}}] }
	}

	proc apply_all {} {
		# Before anything moves: Apply can change grind, dose, yield, every
		# step's temperature and the profile in one press.
		catch { ::crema::advisor::capture_undo }
		set a ::crema::advisor::advice
		# capture the grind delta BEFORE anything (a profile switch could move
		# grinder_setting) so the status line is right
		set target [set ${a}(grind_target)]
		set grind_changes [expr {$target ne "" && $target != $::settings(grinder_setting)}]
		# PROFILE FIRST: select_profile / a created profile loads the profile's OWN
		# yield + temperature (+ dose), so it MUST run before apply_grind/apply_recipe
		# or it clobbers the AI's target_yield / temperature / dose (the exact bug
		# where Apply switched the profile but left yield/temp on the profile default).
		set made_profile 0
		if {[set ${a}(created_profile)] ne ""} {
			::crema::advisor::apply_created_profile
			set made_profile 1
		} elseif {[set ${a}(profile_action)] eq "switch"} {
			::crema::advisor::apply_profile_switch
		}
		# now force the AI's grind + recipe on top so they win over the profile
		if {$target ne ""} {
			::crema::advisor::apply_grind
		}
		::crema::advisor::apply_recipe
		# Give this bean its OWN named AI profile so Apply always leaves
		# "AI · <bean>" active (not a shared profile like "Best overall pressure
		# profile"). created_profile already saved under this name; for switch/keep
		# snapshot the now-loaded profile + recipe here, after apply_recipe.
		if {!$made_profile} { catch { ::crema::advisor::save_bean_profile } }
		set page [namespace tail [namespace current]]
		variable primary_mode
		set primary_mode "done"
		setlabel $page adv_apply_all "Applied"
		catch { setvis $page adv_undo 1 }
		# snapshot the applied dial-in onto this bean so a starting point (which has
		# no shot to restore from) survives switching beans and coming back
		catch { ::crema::advisor::persist_bean_dialin }
		if {$grind_changes} {
			catch { dui item config $page adv_status \
				-text "Applied - now dial the grinder to $target" }
		} else {
			catch { dui item config $page adv_status -text "Applied" }
		}
	}

	proc done {} {
		::crema::go_home
	}

	# deep-link from the error state straight to the AI setup wizard
	proc open_setup {} { catch { dui page load crema_setup } }
}

# Called from the advisor's background callbacks. Only refreshes when the
# advice page is actually showing - forcing '-state normal' on its widgets
# from the background leaks them onto whatever page is up (during the page's
# own show{} the old page still reads as current, so show{} calls refresh
# directly instead).
proc ::crema::pages::advice_refresh {} {
	set cur ""
	catch { set cur [dui page current] }
	if {$cur ne "crema_advice"} { return }
	catch { ::crema::pages::crema_advice::refresh }
}

# ---------------------------------------------------------------------------
# crema_beans — bean & grind card (binds straight into ::settings so every
# saved shot carries the metadata)
# ---------------------------------------------------------------------------
namespace eval ::crema::pages::crema_beans {
	variable widgets; array set widgets {}
	variable data;    array set data {}
	variable max_cards 4

	proc ensure_lib {} {
		if {![info exists ::crema_settings(beans)] || ![llength $::crema_settings(beans)]} {
			set ::crema_settings(beans) [list [dict create \
				roaster $::settings(bean_brand) name $::settings(bean_type) \
				roast $::settings(roast_date) dose $::settings(grinder_dose_weight) \
				level [ifexists ::settings(bean_roast_level) ""]]]
			set ::crema_settings(bean_sel) 0
		}
		if {![info exists ::crema_settings(bean_sel)]} { set ::crema_settings(bean_sel) 0 }
		if {![info exists ::settings(bean_roast_level)]} { set ::settings(bean_roast_level) "" }
		# Heal ONLY exact-clone slots (EVERY field identical) with a real name -
		# never key on name+roast alone (that would delete genuinely different
		# beans that share a name or a blank roast date, and re-seed corruption).
		# Re-map bean_sel to the SURVIVING slot of the selected bean BY IDENTITY,
		# never a blind clamp - a clamp after re-indexing is what let save() clobber
		# the wrong slot (the real root of the "two ninga hills" bug).
		set selbean ""
		catch { set selbean [lindex $::crema_settings(beans) $::crema_settings(bean_sel)] }
		set seen {}; set out {}
		foreach b $::crema_settings(beans) {
			set nm ""; catch { set nm [string trim [dict get $b name]] }
			if {$nm ne "" && $nm ne "New bean" && [lsearch -exact $seen $b] >= 0} { continue }
			lappend seen $b; lappend out $b
		}
		if {[llength $out] != [llength $::crema_settings(beans)]} {
			set ::crema_settings(beans) $out
			set ni [lsearch -exact $out $selbean]
			if {$ni >= 0} { set ::crema_settings(bean_sel) $ni }
			catch { ::crema::save_settings }
		}
		# hard bounds-check so lreplace in save() can never target a bad slot
		set n [llength $::crema_settings(beans)]
		if {$::crema_settings(bean_sel) < 0} { set ::crema_settings(bean_sel) 0 }
		if {$::crema_settings(bean_sel) >= $n} { set ::crema_settings(bean_sel) [expr {$n - 1}] }
		reconcile
	}

	# ROOT-CAUSE GUARD for the "two ninga hills" corruption: bean_sel (stored in
	# crema_settings) and the LIVE bean identity (::settings(bean_type), loaded
	# from settings.tdb) are two separate stores that can drift apart - e.g. after
	# an app restart, or an external settings edit. If they disagree, save() would
	# write the live bean's fields into whatever slot bean_sel points at, cloning
	# one bean over another. Here we treat the LIVE bean as the source of truth and
	# snap bean_sel (and the per-bean last_grind) back to the slot that actually
	# matches it, so save() can never target the wrong slot. If the live name
	# matches NO slot, it's a genuine rename in progress - leave bean_sel alone.
	proc reconcile {} {
		if {![info exists ::crema_settings(beans)] || ![llength $::crema_settings(beans)]} { return }
		set bt [string trim [ifexists ::settings(bean_type) ""]]
		if {$bt eq ""} { return }
		set br [string trim [ifexists ::settings(bean_brand) ""]]
		set bd [string trim [ifexists ::settings(roast_date) ""]]
		# Match on FULL identity (name+roaster+roast) first so two beans that share
		# a name can't be confused; fall back to name-only (a roaster/roast edit in
		# progress leaves the live fields ahead of the stored slot for a moment).
		set i 0; set found -1; set namehit -1
		foreach b $::crema_settings(beans) {
			set nm [string trim [ifdict $b name ""]]
			if {$nm eq $bt} {
				if {$namehit < 0} { set namehit $i }
				if {[string trim [ifdict $b roaster ""]] eq $br && \
						[string trim [ifdict $b roast ""]] eq $bd} { set found $i; break }
			}
			incr i
		}
		if {$found < 0} { set found $namehit }
		if {$found < 0} { return }
		# When the live identity matches a DIFFERENT slot than bean_sel currently
		# points at, snap bean_sel to it AND reload that slot's per-bean fields
		# (grind/level/dose). This reload is the critical anti-corruption step:
		# without it the live grinder_setting/level still belong to the PREVIOUS
		# bean, and the next save() would clone them into this slot - which is
		# EXACTLY how ninga hill inherited cloudburst's 0.7/medium after a restart
		# desync. The reload is safe here BECAUSE the slot actually changed: an
		# in-progress grind edit keeps bean_type constant, so it lands on
		# found == bean_sel and skips this whole branch (no edit clobber). A rename
		# in progress matches no slot (found < 0, returned above), so it's safe too.
		if {$::crema_settings(bean_sel) != $found} {
			set ::crema_settings(bean_sel) $found
			set nb [lindex $::crema_settings(beans) $found]
			set ng ""; catch { set ng [dict get $nb grind] }
			if {[string is double -strict $ng] && $ng > 0} {
				set ::settings(grinder_setting) $ng
				set ::crema_settings(last_grind) $ng
			}
			set ::settings(bean_roast_level) [ifdict $nb level ""]
			set ::settings(grinder_dose_weight) [ifdict $nb dose $::settings(grinder_dose_weight)]
			catch { ::save_settings }
			catch { ::crema::save_settings }
		}
	}

	proc pick_level {lv} {
		if {[ifexists ::settings(bean_roast_level) ""] eq $lv} { set lv "" } ;# tap again clears
		set ::settings(bean_roast_level) $lv
		refresh_level
		save
	}

	proc refresh_level {} {
		set page [namespace tail [namespace current]]
		set cur [ifexists ::settings(bean_roast_level) ""]
		foreach lv {light medium dark} {
			set on [expr {$cur eq $lv}]
			catch { dui item config $page rl_${lv}-btn \
				-fill [expr {$on ? [::theme accent] : [::theme button]}] }
			catch { dui item config $page rl_${lv}-lbl \
				-fill [expr {$on ? [::theme accent_text] : [::theme background_text]}] }
		}
	}

	# write the live ::settings bag back into the library slot. The grind is
	# stored PER BEAN here so each bean keeps its own dial even with no shot
	# history (the previous global last_grind got clobbered on bean switch).
	proc save {} {
		ensure_lib
		set i $::crema_settings(bean_sel)
		set g $::settings(grinder_setting)
		catch { if {[string is double -strict $::crema_settings(last_grind)] && $::crema_settings(last_grind) > 0} { set g $::crema_settings(last_grind) } }
		set b [dict create roaster $::settings(bean_brand) name $::settings(bean_type) \
			roast $::settings(roast_date) dose $::settings(grinder_dose_weight) \
			level [ifexists ::settings(bean_roast_level) ""] grind $g]
		# carry over any saved starter dial-in snapshot so editing bean details
		# doesn't wipe the profile/dose/yield a starting point set for this bean
		catch {
			set old [lindex $::crema_settings(beans) $i]
			foreach k {dialin_profile dialin_grind dialin_dose dialin_yield} {
				if {[dict exists $old $k]} { dict set b $k [dict get $old $k] }
			}
		}
		set ::crema_settings(beans) [lreplace $::crema_settings(beans) $i $i $b]
		catch { ::save_settings }
		::crema::save_settings
		catch { ::crema::pages::crema_home::refresh_texts }
	}

	# dict get with a default (missing/partial bean slots must not throw)
	proc ifdict {d k def} {
		if {[catch { dict get $d $k } v]} { return $def }
		if {$v eq ""} { return $def }
		return $v
	}

	# apply a bean dict's saved fields to the live settings, restore its grind
	# from the bean record (the per-bean source of truth), and pull in its
	# yield/profile/AI context from shot history. Returns nothing.
	proc apply_bean {b} {
		# guard: a missing/partial slot must not throw (that left bean_sel desynced
		# and blocked bean switches). Use ifexists-style defaults for every field.
		if {![dict size $b]} { return }
		set ::settings(bean_brand)  [ifdict $b roaster ""]
		set ::settings(bean_type)   [ifdict $b name ""]
		set ::settings(roast_date)  [ifdict $b roast ""]
		set ::settings(grinder_dose_weight) [ifdict $b dose $::settings(grinder_dose_weight)]
		set ::settings(bean_roast_level) [ifdict $b level ""]
		# per-bean grind: the bean's own saved value wins over shot history
		set have_grind 0
		set bg ""
		catch { set bg [dict get $b grind] }
		if {[string is double -strict $bg] && $bg > 0} {
			set ::settings(grinder_setting) $bg
			set ::crema_settings(last_grind) $bg
			set have_grind 1
		}
		catch { ::save_settings }
		catch { ::crema::save_settings }
		# yield/profile/AI context from history; restore grind ONLY if the bean
		# had no saved grind of its own (so we never override the user's dial)
		catch { ::crema::advisor::restore_bean_dialin [ifdict $b name ""] [expr {!$have_grind}] }
	}

	proc select {i} {
		ensure_lib
		set n [llength $::crema_settings(beans)]
		if {![string is integer -strict $i] || $i < 0 || $i >= $n} { return }
		save
		set ::crema_settings(bean_sel) $i
		apply_bean [lindex $::crema_settings(beans) $i]
		refresh_cards
	}

	proc remove_bean {} {
		variable max_cards
		ensure_lib
		if {[llength $::crema_settings(beans)] < 2} { return }
		set i $::crema_settings(bean_sel)
		set ::crema_settings(beans) [lreplace $::crema_settings(beans) $i $i]
		set ::crema_settings(bean_sel) [expr {$i > 0 ? $i - 1 : 0}]
		apply_bean [lindex $::crema_settings(beans) $::crema_settings(bean_sel)]
		refresh_cards
	}

	proc add_bean {} {
		variable max_cards
		save
		if {[llength $::crema_settings(beans)] >= $max_cards} { return }
		lappend ::crema_settings(beans) [dict create roaster "" name "New bean" roast "" dose "" level ""]
		select [expr {[llength $::crema_settings(beans)] - 1}]
	}

	proc refresh_cards {} {
		variable max_cards
		set page [namespace tail [namespace current]]
		ensure_lib
		set n [llength $::crema_settings(beans)]
		for {set i 0} {$i < $max_cards} {incr i} {
			set st [expr {$i < $n ? "normal" : "hidden"}]
			foreach t [list bcard_${i}* bname_$i bsub_$i bmeta_$i bsel_$i btap_${i}*] {
				catch { dui item config $page $t -state $st }
			}
			if {$i >= $n} { continue }
			set b [lindex $::crema_settings(beans) $i]
			set sel [expr {$i == $::crema_settings(bean_sel)}]
			set name [ifdict $b name ""]
			if {$name eq ""} { set name "Unnamed" }
			catch { dui item config $page bname_$i -text $name \
				-fill [expr {$sel ? [::theme accent] : [::theme background_text]}] }
			catch { dui item config $page bsub_$i -text [ifdict $b roaster ""] }
			set meta ""
			catch {
				set days [expr {([clock seconds] - [clock scan [dict get $b roast] -format "%Y-%m-%d"]) / 86400}]
				if {$days >= 0 && $days < 400} { set meta "roasted ${days}d ago" }
			}
			catch {
				set dose [dict get $b dose]
				if {$dose ni {0 {} 0.0}} {
					if {$meta ne ""} { append meta "  ·  " }
					append meta "dose ${dose} g"
				}
			}
			catch { dui item config $page bmeta_$i -text $meta }
			catch { dui item config $page bsel_$i -state [expr {$sel ? "normal" : "hidden"}] }
		}
		set addst [expr {$n < $max_cards ? "normal" : "hidden"}]
		catch { dui item config $page bean_add* -state $addst }
		if {$n >= $max_cards} {
			catch { dui item config $page beans_cap_msg -text "Max $max_cards beans — remove one to add another." }
		} else {
			catch { dui item config $page beans_cap_msg -text "" }
		}
		set rmst [expr {$n > 1 ? "normal" : "hidden"}]
		catch { dui item config $page bean_remove* -state $rmst }
		catch { refresh_level }
		# repaint the grind card too - a bean switch auto-restores that bean's
		# grind, so the number must update to match (else it shows the old bean's)
		catch { refresh_grind }
	}

	proc bump_grind {delta} {
		set cur [expr {[string is double -strict $::crema_settings(last_grind)] && $::crema_settings(last_grind) > 0 \
			? $::crema_settings(last_grind) : $::settings(grinder_setting)}]
		if {![string is double -strict $cur]} { set cur 0 }
		set v [::crema::snap_grind [expr {$cur + $delta}]]
		set ::settings(grinder_setting) $v
		# persist to Crema's durable per-bean grind memory too, so it sticks and
		# feeds the current_grind used on the feedback page + bean restore
		set ::crema_settings(last_grind) $v
		refresh_grind
		# persist immediately - don't rely on tab-away (device bug #1)
		catch { ::save_settings }
		catch { ::crema::save_settings }
	}

	proc refresh_grind {} {
		set page [namespace tail [namespace current]]
		set g $::settings(grinder_setting)
		catch {
			if {[string is double -strict $::crema_settings(last_grind)] && $::crema_settings(last_grind) > 0} {
				set g $::crema_settings(last_grind)
			}
		}
		catch { dui item config $page grind_value -text $g }
		catch { dui item config $page beans_grind_eyebrow \
			-text "GRIND · [::crema::grinder_label]" }
	}

	proc entry_row {page x y width label var} {
		dui add dtext $page $x [expr {$y - 46}] -text [string toupper $label] \
			-font_family "Mazzard Medium" -font_size 13 -fill [::theme muted] -anchor w
		dui add entry $page $x $y -canvas_width $width -font_size 22 \
			-textvariable $var -borderwidth 0 -relief flat -highlightthickness 1 \
			-highlightcolor [::theme accent] -highlightbackground [::theme card_outline] \
			-bg [::theme card_fill] -foreground [::theme background_text] \
			-insertbackground [::theme accent]
	}

	proc setup {} {
		variable max_cards
		set page [namespace tail [namespace current]]

		dui add dtext $page 120 100 -text "Beans & grind" \
			-font_family "Mazzard SemiBold" -font_size 34 \
			-fill [::theme background_text] -anchor w

		# bean library cards
		for {set i 0} {$i < $max_cards} {incr i} {
			set y [expr {230 + $i * 195}]
			dui add shape round $page 120 $y -bwidth 740 -bheight 170 \
				-fill [::theme button] -radius 22 -tags [list bcard_$i btap_$i]
			dui add shape round $page 132 [expr {$y + 25}] -bwidth 9 -bheight 120 \
				-radius 4 -fill [::theme accent] -tags [list bsel_$i btap_$i] -initial_state hidden
			dui add dtext $page 175 [expr {$y + 28}] -text "" -tags [list bname_$i btap_$i] \
				-font_family "Mazzard SemiBold" -font_size 21 \
				-fill [::theme background_text] -anchor nw -width 640
			dui add dtext $page 175 [expr {$y + 82}] -text "" -tags [list bsub_$i btap_$i] \
				-font_size 15 -fill [::theme muted] -anchor nw -width 640
			dui add dtext $page 175 [expr {$y + 125}] -text "" -tags [list bmeta_$i btap_$i] \
				-font_size 13 -fill [::theme muted] -anchor nw -width 640
			dui add dbutton $page 120 $y 860 [expr {$y + 170}] -tags [list bhit_$i btap_$i] \
				-fill {} -label "" \
				-command [list ::crema::pages::crema_beans::select $i]
			catch { .can bind btap_$i [::dui::platform::button_press] \
				[list ::crema::pages::crema_beans::select $i] }
		}
		dui add dbutton $page 120 1020 460 1110 -tags bean_add -shape outline \
			-outline [::theme card_outline] -arc_offset 24 -label "+ New bean" \
			-label_pos {0.5 0.5} -label_font_size 17 -label_fill [::theme muted] \
			-command ::crema::pages::crema_beans::add_bean
		dui add dbutton $page 500 1020 860 1110 -tags bean_remove -shape outline \
			-outline [::theme card_outline] -arc_offset 24 -label "− Remove" \
			-label_pos {0.5 0.5} -label_font_size 17 -label_fill [::theme muted] \
			-command ::crema::pages::crema_beans::remove_bean
		# explains why "+ New bean" disappears at the cap (it used to just vanish)
		dui add dtext $page 120 1150 -text "" -tags beans_cap_msg \
			-font_family "Mazzard Medium" -font_size 16 -fill [::theme muted] -anchor w -width 740

		entry_row $page 120 1250 700 "Advisor URL" {::crema_settings(server_url)}

		# selected bean fields
		entry_row $page 990 320 760 "Roaster" {::settings(bean_brand)}
		entry_row $page 990 540 760 "Beans" {::settings(bean_type)}
		entry_row $page 990 760 760 "Roast date (YYYY-MM-DD)" {::settings(roast_date)}
		dui add dtext $page 990 812 -text "" -tags beans_date_hint \
			-font_family "Mazzard Medium" -font_size 14 -fill [::theme accent] -anchor w -width 760
		entry_row $page 990 980 760 "Dose (g)" {::settings(grinder_dose_weight)}

		# roast level selector (feeds the AI advisor)
		dui add dtext $page 990 1195 -text "ROAST LEVEL (helps the AI)" \
			-font_family "Mazzard Medium" -font_size 14 -fill [::theme muted] -anchor w
		set lx 990
		foreach {lv label} {light "Light" medium "Medium" dark "Dark"} {
			dui add dbutton $page $lx 1230 [expr {$lx + 236}] 1320 -tags rl_$lv \
				-shape round -radius 22 -fill [::theme button] -label $label \
				-label_pos {0.5 0.5} -label_font_size 19 -label_fill [::theme background_text] \
				-command [list ::crema::pages::crema_beans::pick_level $lv]
			set lx [expr {$lx + 262}]
		}

		# grind card
		dui add shape round $page 1880 260 -bwidth 560 -bheight 560 \
			-fill [::theme card_fill] -radius 28
		dui add shape outline $page 1880 260 -bwidth 560 -bheight 560 \
			-outline [::theme card_outline] -width 2 -arc_offset 28
		dui add dtext $page 2160 330 -text "GRIND" -tags beans_grind_eyebrow \
			-font_family "Mazzard Medium" -font_size 14 -fill [::theme muted] \
			-anchor center -justify center
		dui add dtext $page 2160 510 -text $::settings(grinder_setting) -tags grind_value \
			-font_family "Mazzard Medium" -font_size 96 -fill [::theme accent] \
			-anchor center -justify center
		dui add dtext $page 2160 630 -text "finer  <        >  coarser" -font_size 14 \
			-fill [::theme muted] -anchor center -justify center
		dui add dbutton $page 1930 690 2140 790 -tags grind_minus -shape round -radius 22 \
			-fill [::theme button] -label "-0.05" -label_pos {0.5 0.5} \
			-label_font_size 22 -label_fill [::theme background_text] \
			-command [list ::crema::pages::crema_beans::bump_grind -0.05]
		dui add dbutton $page 2180 690 2390 790 -tags grind_plus -shape round -radius 22 \
			-fill [::theme button] -label "+0.05" -label_pos {0.5 0.5} \
			-label_font_size 22 -label_fill [::theme background_text] \
			-command [list ::crema::pages::crema_beans::bump_grind 0.05]

		# explicit Save (edits also autosave on tab-away, but this is the
		# discoverable affordance - device bug #3)
		dui add dbutton $page 1880 900 2440 1030 -tags beans_save -shape round -radius 28 \
			-fill [::theme accent] -label "Save" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 22 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_beans::save_and_confirm

		dui add dtext $page 2160 1070 -text "" -tags beans_saved_msg -font_size 15 \
			-fill [::theme primary_dark] -anchor center -justify center

		::crema::pages::add_nav $page beans ::crema::pages::crema_beans::save
	}

	proc save_and_confirm {} {
		save
		set page [namespace tail [namespace current]]
		refresh_cards
		check_roast_date
		catch { dui item config $page beans_saved_msg -text "Saved ✓" }
		# NEW bean (real name, no shots yet) -> hand off to the AI starting-point
		# offer so it's obvious you can get a profile / grind / dose / temp to start
		# from, instead of inheriting whatever was loaded. Existing beans just stay.
		set handoff 0
		catch {
			set bn [string trim [ifexists ::settings(bean_type) ""]]
			if {$bn ni {"" "New bean" "Unnamed"} && ![llength [::crema::store::recent 1 $bn]]} { set handoff 1 }
		}
		if {$handoff} {
			after 900 { catch { dui page load crema_advice } }
		} else {
			after 2500 [list catch [list dui item config $page beans_saved_msg -text ""]]
		}
	}

	# flag a malformed roast date so the "days off roast" calc (which the AI uses)
	# doesn't just fail silently and drop freshness from the advice
	proc check_roast_date {} {
		set page [namespace tail [namespace current]]
		set rd [string trim [ifexists ::settings(roast_date) ""]]
		set ok 1
		if {$rd ne ""} {
			if {![regexp {^\d{4}-\d{2}-\d{2}$} $rd] || [catch { clock scan $rd -format "%Y-%m-%d" }]} { set ok 0 }
		}
		catch { dui item config $page beans_date_hint \
			-text [expr {$ok ? "" : "Use YYYY-MM-DD (e.g. 2026-08-01) so “days off roast” works."}] }
	}

	proc show {args} {
		ensure_lib
		refresh_cards
		refresh_grind
		check_roast_date
	}
}

# ---------------------------------------------------------------------------
# crema_reconsider - push back on the AI's advice (quick reasons + free text),
# then re-ask. Reached from the shot detail page's "Disagree" button.
# ---------------------------------------------------------------------------
namespace eval ::crema::pages::crema_reconsider {
	variable data
	array set data {id ""}
	variable selected {}
	variable busy 0
	# key  short-label(on chip)                      full objection sent to the AI
	variable chips {
		slow    "Already ran slow"      "This shot already ran slow, so slowing it further seems wrong to me."
		worse   "Tasted worse that way" "I have tried that direction before and it tasted worse, not better."
		grind   "Different grind"       "I was not on the grind you assumed - re-check the dial I actually used."
		hot     "Hot enough already"    "The brew temperature is already high enough; I do not want to go hotter."
		channel "Maybe channeling"      "The flow looked or felt uneven - could this be channeling rather than grind?"
		lever   "Try another lever"     "I would rather change the ratio or the profile than the grind."
	}

	proc setup {} {
		variable chips
		set page [namespace tail [namespace current]]
		set ::crema_reconsider_freetext ""

		dui add dbutton $page 120 60 620 140 -tags rc_back -fill {} \
			-label "‹ Shot" -label_pos {0 0.5} -label_anchor w \
			-label_font_size 17 -label_fill [::theme accent] \
			-command ::crema::pages::crema_reconsider::back

		dui add dtext $page 120 200 -text "Push back on the advice" \
			-font_family "Mazzard SemiBold" -font_size 34 \
			-fill [::theme background_text] -anchor w
		dui add dtext $page 120 285 -text "" -tags rc_context -font_size 18 \
			-fill [::theme muted] -anchor nw -width 2320

		dui add dtext $page 120 420 -text "WHY DO YOU DISAGREE?  (tap any, or type below)" \
			-font_family "Mazzard Medium" -font_size 14 -fill [::theme muted] -anchor w

		set row 0; set col 0
		foreach {key short full} $chips {
			set cx [expr {120 + $col * 740}]
			set cy [expr {480 + $row * 130}]
			dui add dbutton $page $cx $cy [expr {$cx + 700}] [expr {$cy + 110}] \
				-tags rc_chip_$key -shape round -radius 22 -fill [::theme button] \
				-label $short -label_pos {0.5 0.5} -label_font_size 19 \
				-label_fill [::theme background_text] \
				-command [list ::crema::pages::crema_reconsider::toggle $key]
			incr col
			if {$col >= 3} { set col 0; incr row }
		}

		dui add dtext $page 120 810 -text "OR TYPE YOUR OWN" \
			-font_family "Mazzard Medium" -font_size 14 -fill [::theme muted] -anchor w
		dui add entry $page 120 860 -canvas_width 2220 -font_size 22 \
			-textvariable ::crema_reconsider_freetext -borderwidth 0 -relief flat \
			-highlightthickness 1 -highlightcolor [::theme accent] \
			-highlightbackground [::theme card_outline] -bg [::theme card_fill] \
			-foreground [::theme background_text] -insertbackground [::theme accent]

		dui add dbutton $page 120 990 820 1120 -tags rc_go -shape round -radius 28 \
			-fill [::theme accent] -label "Reconsider" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 24 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_reconsider::submit
		dui add dtext $page 120 1200 -text "" -tags rc_status -font_size 17 \
			-fill [::theme muted] -anchor w -width 2200

		::crema::pages::add_nav $page {}
	}

	proc open {id} {
		variable data
		variable selected
		set data(id) $id
		set selected {}
		set ::crema_reconsider_freetext ""
		catch { dui page load crema_reconsider }
	}

	proc show {args} {
		variable busy
		set busy 0
		refresh_chips
		refresh_context
		set page [namespace tail [namespace current]]
		catch { dui item config $page rc_status -text "" }
		catch { dui item config $page rc_go-lbl -text "Reconsider" }
	}

	proc back {} {
		variable data
		if {$data(id) ne ""} { ::crema::pages::crema_shot::open $data(id) } \
		else { dui page load crema_dashboard }
	}

	proc toggle {key} {
		variable selected
		if {$key in $selected} {
			set selected [lsearch -all -inline -not -exact $selected $key]
		} else {
			lappend selected $key
		}
		refresh_chips
	}

	proc refresh_chips {} {
		variable selected
		variable chips
		set page [namespace tail [namespace current]]
		foreach {key short full} $chips {
			set on [expr {$key in $selected}]
			catch { dui item config $page rc_chip_${key}-btn \
				-fill [expr {$on ? [::theme accent] : [::theme button]}] }
			catch { dui item config $page rc_chip_${key}-lbl \
				-fill [expr {$on ? [::theme accent_text] : [::theme background_text]}] }
		}
	}

	proc refresh_context {} {
		variable data
		set page [namespace tail [namespace current]]
		set txt "You are disagreeing with the AI's last advice for this shot."
		catch {
			set rec [::crema::store::get $data(id)]
			set sum ""
			catch { set sum [dict get $rec advice screen_summary] }
			if {$sum ne "" && $sum ne "null"} {
				set txt "The AI said:  “$sum”"
			}
		}
		catch { dui item config $page rc_context -text $txt }
	}

	proc reason_text {} {
		variable selected
		variable chips
		set parts {}
		foreach {key short full} $chips {
			if {$key in $selected} { lappend parts $full }
		}
		set ft [string trim [ifexists ::crema_reconsider_freetext ""]]
		if {$ft ne ""} { lappend parts $ft }
		return [join $parts " "]
	}

	proc submit {} {
		variable data
		variable busy
		set page [namespace tail [namespace current]]
		if {$busy} { return }
		set reason [reason_text]
		if {$reason eq ""} {
			catch { dui item config $page rc_status \
				-text "Tap a reason or type why you disagree first." }
			return
		}
		set busy 1
		catch { dui item config $page rc_go-lbl -text "Re-asking…" }
		catch { dui item config $page rc_status \
			-text "Re-asking the AI with your feedback… usually 15-60 seconds." }
		catch { update }
		after 200 [list ::crema::advisor::reconsider_stored $data(id) $reason \
			::crema::pages::crema_reconsider::done]
	}

	proc done {outcome payload} {
		variable data
		variable busy
		set busy 0
		set page [namespace tail [namespace current]]
		catch { dui item config $page rc_go-lbl -text "Reconsider" }
		if {$outcome eq "ok"} {
			# revised advice is saved on the record - reopen the shot to show it
			::crema::pages::crema_shot::open $data(id)
		} else {
			catch { dui item config $page rc_status \
				-text "Couldn't reconsider: $payload" }
		}
	}
}

# ---------------------------------------------------------------------------
# page registration + home-screen entry button
# ---------------------------------------------------------------------------
proc ::crema::pages::init {} {
	dui page add crema_qa        -namespace ::crema::pages::crema_qa
	dui page add crema_advice    -namespace ::crema::pages::crema_advice
	dui page add crema_beans     -namespace ::crema::pages::crema_beans
	dui page add crema_dashboard -namespace ::crema::pages::crema_dashboard
	dui page add crema_shot      -namespace ::crema::pages::crema_shot
	dui page add crema_reconsider -namespace ::crema::pages::crema_reconsider
	::crema::pages::home_init
	::crema::pages::setup_init
}
