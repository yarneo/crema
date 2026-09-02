# crema_shot — per-shot detail page (design: Shot detail screen).
# Back link, bean + date + stars, stat chips, the shot's stored curves
# replayed into dedicated BLT vectors, and the advice note.

catch { blt::vector create crema_hist_time }
catch { blt::vector create crema_hist_pressure }
catch { blt::vector create crema_hist_flow }
catch { blt::vector create crema_hist_weight }
# the comparison overlay's own vectors; BLT does not create these implicitly
catch { blt::vector create crema_cmp_time }
catch { blt::vector create crema_cmp_pressure }
catch { blt::vector create crema_cmp_flow }
# Temperature, plotted at a tenth of its value so it shares the 0-12 axis with
# pressure and flow — the convention every DE1 chart uses.
catch { blt::vector create crema_hist_temp }
catch { blt::vector create crema_cmp_temp }

namespace eval ::crema::pages::crema_shot {
	variable widgets; array set widgets {}
	variable data;    array set data {}

	proc setup {} {
		set page [namespace tail [namespace current]]

		dui add dbutton $page 120 60 620 140 -tags shot_back -fill {} \
			-label "‹ Recent shots" -label_pos {0 0.5} -label_anchor w \
			-label_font_size 17 -label_fill [::theme accent] \
			-command { dui page load crema_dashboard }

		dui add dtext $page 120 170 -text "" -tags shot_bean \
			-font_family "Mazzard SemiBold" -font_size 32 \
			-fill [::theme background_text] -anchor nw
		dui add dtext $page 800 190 -text "" -tags shot_date -font_size 18 \
			-fill [::theme muted] -anchor nw
		dui add dtext $page 2440 190 -text "" -tags shot_stars -font_size 24 \
			-fill [::theme accent] -anchor ne

		# stat chips
		set chips {grind "GRIND" time "TIME" inout "IN › OUT" temp "TEMP" taste "TASTE"}
		set x 120
		foreach {key label} $chips {
			set w [expr {$key eq "inout" ? 560 : 300}]
			dui add shape round $page $x 270 -bwidth $w -bheight 130 \
				-fill [::theme button] -radius 22
			dui add dtext $page [expr {$x + 28}] 300 -text $label \
				-font_family "Mazzard Medium" -font_size 12 -fill [::theme muted] -anchor w
			set fill [::theme background_text]
			if {$key eq "grind"} { set fill [::theme accent] }
			if {$key eq "taste"} { set fill [::theme secondary] }
			dui add dtext $page [expr {$x + 28}] 358 -text "" -tags chip_$key \
				-font_family "Mazzard Medium" -font_size 25 -fill $fill -anchor w
			set x [expr {$x + $w + 24}]
		}

		# curve card
		dui add shape round $page 120 450 -bwidth 2320 -bheight 620 \
			-fill [::theme card_fill] -radius 28
		dui add shape outline $page 120 450 -bwidth 2320 -bheight 620 \
			-outline [::theme card_outline] -width 2 -arc_offset 28

		add_de1_widget crema_shot graph 160 480 {
			$widget axis configure x -color [::theme dim] -tickfont Helv_6
			$widget axis configure y -color [::theme dim] -tickfont Helv_6 -min 0.0 \
				-max 12 -subdivisions 5 -majorticks {0 2 4 6 8 10 12} -hide 0
			$widget grid configure -color [::theme grid_line] -hide no -minor no
			# Comparison overlay, created FIRST so it draws beneath the real
			# curves: the shot you opened must stay the subject, with the older
			# one behind it for reference.
			$widget element create cmp_pressure -xdata crema_cmp_time \
				-ydata crema_cmp_pressure -symbol none -label "" \
				-linewidth [rescale_x_skin 4] -color [::theme dim] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create cmp_flow -xdata crema_cmp_time \
				-ydata crema_cmp_flow -symbol none -label "" \
				-linewidth [rescale_x_skin 4] -color [::theme dim] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create cmp_temp -xdata crema_cmp_time \
				-ydata crema_cmp_temp -symbol none -label "" \
				-linewidth [rescale_x_skin 4] -color [::theme dim] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create hist_weight -xdata crema_hist_time \
				-ydata crema_hist_weight -symbol none -label "" \
				-linewidth [rescale_x_skin 6] -color [::theme weight] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create hist_flow -xdata crema_hist_time \
				-ydata crema_hist_flow -symbol none -label "" \
				-linewidth [rescale_x_skin 8] -color [::theme secondary] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			$widget element create hist_pressure -xdata crema_hist_time \
				-ydata crema_hist_pressure -symbol none -label "" \
				-linewidth [rescale_x_skin 8] -color [::theme primary] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
			# Basket temperature. It reads roughly 20C under the water, so it is
			# kept out of the advisor's prompt — but for comparing two shots it
			# is exactly what shows how the puck behaved, which is what the
			# forum request was actually about.
			$widget element create hist_temp -xdata crema_hist_time \
				-ydata crema_hist_temp -symbol none -label "" \
				-linewidth [rescale_x_skin 5] -color [::theme accent] \
				-smooth $::settings(live_graph_smoothing_technique) -pixels 0
		} -plotbackground [::theme card_fill] -width [rescale_x_skin 2240] \
			-height [rescale_y_skin 540] -borderwidth 0 -background [::theme card_fill] \
			-plotrelief flat -plotpady {14 0} -plotpadx 10

		# advice note card
		dui add shape round $page 120 1110 -bwidth 2320 -bheight 340 \
			-fill [::theme button] -radius 24
		dui add shape round $page 160 1145 -bwidth 70 -bheight 56 -radius 14 \
			-fill [::theme accent]
		dui add dtext $page 195 1173 -text "AI" -font_family "Mazzard SemiBold" \
			-font_size 15 -fill [::theme accent_text] -anchor center -justify center
		dui add dtext $page 265 1135 -text "" -tags shot_note -font_size 16 \
			-fill [::theme button_text_dark] -anchor nw -width 1120

		# re-run advice for a shot that has none (shown only when there's no advice)
		dui add dbutton $page 1960 1230 2400 1360 -tags shot_getadvice -shape round -radius 32 \
			-initial_state hidden -fill [::theme accent] -label "Get advice" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 22 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_shot::request_advice

		# disagree with the advice - opens the push-back page (advice exists only)
		dui add dbutton $page 1410 1230 1720 1360 -tags shot_disagree -shape round -radius 32 \
			-initial_state hidden -fill [::theme button] \
			-outline [::theme card_outline] -bwidth 2 \
			-label "Disagree" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 20 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_shot::open_disagree

		# re-run advice for a shot that already has some (re-asks the AI with the
		# current prompt/model - shown only when advice already exists)
		dui add dbutton $page 1750 1230 2060 1360 -tags shot_rerun -shape round -radius 32 \
			-initial_state hidden -fill [::theme button] \
			-outline [::theme card_outline] -bwidth 2 \
			-label "Re-run" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 20 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_shot::request_advice

		# apply this shot's advice to the machine (shown when advice has changes)
		dui add dbutton $page 2090 1230 2400 1360 -tags shot_apply -shape round -radius 32 \
			-initial_state hidden -fill [::theme accent] -label "Apply to machine" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 16 \
			-label_fill [::theme accent_text] \
			-command ::crema::pages::crema_shot::apply_advice

		# delete this shot from history - two-tap confirm (no modal dialog), since
		# a stray tap shouldn't wipe a record
		# Overlaying the previous shot with the same bean has been asked for on
		# the Decent forum since 2023, and it needs no AI: it is the fastest way
		# to see what a change actually did.
		dui add dbutton $page 2160 50 2440 132 -tags shot_compare -shape round -radius 20 \
			-fill [::theme button] -outline [::theme card_outline] -bwidth 2 \
			-label "Compare" -label_pos {0.5 0.5} -label_font_family "Mazzard Medium" \
			-label_font_size 15 -label_fill [::theme background_text] \
			-command ::crema::pages::crema_shot::toggle_compare

		dui add dbutton $page 1780 50 2130 132 -tags shot_delete -shape round -radius 20 \
			-fill [::theme button] -outline [::theme card_outline] -bwidth 2 \
			-label "Delete" -label_pos {0.5 0.5} \
			-label_font_family "Mazzard SemiBold" -label_font_size 18 \
			-label_fill [::theme muted] \
			-command ::crema::pages::crema_shot::delete_press

		::crema::pages::add_nav $page shots
	}

	variable del_armed 0
	proc delete_press {} {
		variable del_armed
		variable data
		set page [namespace tail [namespace current]]
		if {![info exists data(id)] || $data(id) eq ""} { return }
		if {!$del_armed} {
			set del_armed 1
			catch { dui item config $page shot_delete-lbl -text "Tap again" -fill [::theme accent] }
			after 3000 ::crema::pages::crema_shot::_disarm_delete
			return
		}
		set del_armed 0
		catch { ::crema::store::delete $data(id) }
		catch { dui page load crema_dashboard }
	}
	proc _disarm_delete {} {
		variable del_armed
		set del_armed 0
		set page [namespace tail [namespace current]]
		catch { dui item config $page shot_delete-lbl -text "Delete" -fill [::theme muted] }
	}

	proc apply_advice {} {
		variable data
		set page [namespace tail [namespace current]]
		if {![info exists data(advice)]} { return }
		set gt ""; catch { set gt [dict get $data(advice) actions grind target] }
		set grind_moves [expr {[string is double -strict $gt] && $gt != $::settings(grinder_setting)}]
		if {[catch { ::crema::advisor::apply_stored_advice $data(advice) } e]} {
			catch { dui item config $page shot_note -text "Couldn't apply: $e" }
			return
		}
		catch { dui item config $page shot_apply* -state hidden }
		if {$grind_moves} {
			catch { dui item config $page shot_note -text "Applied - now dial your grinder to $gt." }
		} else {
			catch { dui item config $page shot_note -text "Applied to the machine (temperature / recipe / profile)." }
		}
	}

	proc open_disagree {} {
		variable data
		if {![info exists data(id)] || $data(id) eq ""} { return }
		::crema::pages::crema_reconsider::open $data(id)
	}

	proc request_advice {} {
		variable data
		set page [namespace tail [namespace current]]
		if {![info exists data(id)] || $data(id) eq ""} { return }
		catch { dui item config $page shot_getadvice* -state hidden }
		catch { dui item config $page shot_rerun* -state hidden }
		catch { dui item config $page shot_disagree* -state hidden }
		catch { dui item config $page shot_apply* -state hidden }
		catch { dui item config $page shot_note -text "Getting advice from the AI..." }
		catch { update }
		# defer so the "Getting advice..." note paints before the blocking request
		after 200 [list ::crema::advisor::advise_stored $data(id) \
			::crema::pages::crema_shot::advice_result]
	}

	proc advice_result {outcome payload} {
		variable data
		set page [namespace tail [namespace current]]
		if {$outcome eq "ok"} {
			# reload the shot - it now has advice, so the note fills and the button hides
			::crema::history::get $data(id) ::crema::pages::crema_shot::loaded
		} else {
			catch { dui item config $page shot_note \
				-text "Couldn't get advice.\n$payload\n\nTap Get advice to retry." }
			catch { dui item config $page shot_getadvice* -state normal }
		}
	}

	proc open {shot_id} {
		variable data
		set data(id) $shot_id
		catch { dui page load crema_shot }
		clear
		::crema::history::get $shot_id ::crema::pages::crema_shot::loaded
	}

	proc clear {} {
		variable data
		set page [namespace tail [namespace current]]
		catch { unset data(advice) }
		foreach t {shot_bean shot_date shot_stars shot_note} {
			catch { dui item config $page $t -text "" }
		}
		foreach t {chip_grind chip_time chip_inout chip_temp chip_taste} {
			catch { dui item config $page $t -text "-" }
		}
		catch { dui item config $page shot_getadvice* -state hidden }
		catch { dui item config $page shot_apply* -state hidden }
		catch { crema_hist_time set {0} }
		catch { crema_hist_pressure set {0} }
		catch { crema_hist_flow set {0} }
		catch { crema_hist_weight set {0} }
		catch { crema_hist_temp set {0} }
		clear_compare
	}

	# ---- comparison overlay -----------------------------------------------

	proc clear_compare {} {
		variable data
		set data(comparing) 0
		catch { unset data(cmp_ids) }
		catch { unset data(cmp_idx) }
		set page [namespace tail [namespace current]]
		catch { crema_cmp_time set {0} }
		catch { crema_cmp_pressure set {0} }
		catch { crema_cmp_flow set {0} }
		catch { crema_cmp_temp set {0} }
		catch { dui item config $page shot_compare-lbl -text "Compare" }
	}

	proc set_compare_label {txt} {
		set page [namespace tail [namespace current]]
		catch { dui item config $page shot_compare-lbl -text $txt }
	}

	# Each press walks one shot further back through this bean's history; the
	# press after the oldest turns the overlay off. DSx lets you pick a shot
	# from a list, which is better on a big screen — this is the same idea in
	# one button, and the label always says which shot you are looking at.
	proc toggle_compare {} {
		variable data
		if {[info exists data(cmp_ids)] && [llength $data(cmp_ids)]} {
			advance_compare
			return
		}
		if {![info exists data(bean)] || $data(bean) eq ""} {
			set_compare_label "no bean"
			return
		}
		set_compare_label "loading"
		# Filtering by bean matters: comparing against a different coffee tells
		# you nothing about a change you made.
		::crema::history::recent 25 ::crema::pages::crema_shot::compare_list $data(bean)
	}

	proc advance_compare {} {
		variable data
		set ids [ifexists data(cmp_ids) {}]
		set i [expr {[ifexists data(cmp_idx) -1] + 1}]
		if {$i >= [llength $ids]} { clear_compare; return }
		set data(cmp_idx) $i
		set_compare_label "loading"
		::crema::history::get [lindex $ids $i] ::crema::pages::crema_shot::compare_loaded
	}

	proc compare_list {rows} {
		variable data
		set mine [ifexists data(created_at) ""]
		set ids {}
		# rows arrive newest-first, so keeping that order walks backwards in time
		foreach r $rows {
			set id ""; set at ""
			catch { set id [dict get $r id] }
			catch { set at [dict get $r created_at] }
			if {$id eq "" || $id eq [ifexists data(id) ""]} { continue }
			if {$mine ne "" && $at ne "" && $at >= $mine} { continue }
			lappend ids $id
		}
		if {![llength $ids]} {
			set_compare_label "no earlier"
			return
		}
		set data(cmp_ids) $ids
		set data(cmp_idx) -1
		advance_compare
	}

	proc compare_loaded {s} {
		variable data
		if {![llength $s]} { set_compare_label "unavailable"; return }
		if {[catch {
			set p [dict get $s payload]
			set elapsed [dict get $p elapsed]
			set pres    [dict get $p pressure]
			set flow    [dict get $p flow]
			set bt {}
			catch { set bt [dict get $p basket_temp] }
			set T {}; set P {}; set F {}; set C {}
			for {set i 0} {$i < [llength $elapsed]} {incr i} {
				set t [lindex $elapsed $i]
				if {![string is double -strict $t]} { continue }
				lappend T $t
				foreach {src dst} [list $pres P $flow F] {
					set v [lindex $src $i]
					if {![string is double -strict $v]} { set v 0 }
					lappend $dst $v
				}
				set c [lindex $bt $i]
				lappend C [expr {[string is double -strict $c] ? $c / 10.0 : 0}]
			}
			if {[llength $T] < 2} { error "no usable curve" }
			crema_cmp_time set $T
			crema_cmp_pressure set $P
			crema_cmp_flow set $F
			catch { crema_cmp_temp set $C }
			set data(comparing) 1
			set when ""
			catch { set when [string range [dict get $s created_at] 5 9] }
			set_compare_label [expr {$when eq "" ? {comparing} : "vs $when"}]
		} err]} {
			msg -ERROR "crema: compare failed: $err"
			clear_compare
			set_compare_label "unavailable"
		}
	}

	proc nn {v} {
		if {$v eq "null"} { return "" }
		return $v
	}

	proc loaded {s} {
		variable data
		set page [namespace tail [namespace current]]
		if {![llength $s]} {
			catch { dui item config $page shot_note -text "Could not load shot." }
			return
		}
		if {[catch {
			set p [dict get $s payload]
			set a {}
			catch { set a [dict get $p answers] }

			catch { set data(bean) [nn [dict get $p bean name]] }
			catch { set data(created_at) [dict get $s created_at] }
			catch { dui item config $page shot_bean -text [nn [dict get $p bean name]] }
			catch { dui item config $page shot_date \
				-text [string map {T "  "} [string range [dict get $s created_at] 0 15]] }
			catch {
				set e [nn [dict get $a enjoyment]]
				if {[string is integer -strict $e]} {
					dui item config $page shot_stars \
						-text "[string repeat ★ $e][string repeat ☆ [expr {5 - $e}]]"
				}
			}

			catch { dui item config $page chip_grind -text [nn [dict get $p grinder setting]] }
			set d ""
			catch { set d [dict get $p duration_s] }
			if {![string is double -strict $d]} {
				catch { set d [lindex [dict get $p elapsed] end] }
			}
			if {[string is double -strict $d]} {
				catch { dui item config $page chip_time -text "[format %.0f $d]s" }
			}
			catch {
				set din [nn [dict get $p dose_g]]; set dout [nn [dict get $p final_yield_g]]
				if {[string is double -strict $din] && $din > 0 && [string is double -strict $dout]} {
					# append the brew ratio (1:2.1) - the number baristas dial in by
					set r ""
					if {$dout > 0.3} { set r " · 1:[format %.1f [expr {$dout/double($din)}]]" }
					dui item config $page chip_inout -text "[format %.1f $din] › [format %.1f $dout]g$r"
				}
			}
			catch {
				# prefer the real brew temperature; the basket_temp curve is a
				# metal-sensor reading that runs ~20C cooler than the water
				set bt ""; catch { set bt [dict get $p brew_temp] }
				if {[string is double -strict $bt] && $bt > 0} {
					dui item config $page chip_temp -text "[format %.0f $bt]C"
				} else {
					set temps {}
					catch {
						foreach t [dict get $p basket_temp] {
							if {[string is double -strict $t] && $t > 0} { lappend temps $t }
						}
					}
					if {[llength $temps]} {
						dui item config $page chip_temp \
							-text "[format %.0f [tcl::mathfunc::max {*}$temps]]C"
					}
				}
			}
			catch { dui item config $page chip_taste -text [nn [dict get $a taste_balance]] }

			set adv {}
			catch { set adv [dict get $s advice] }
			set note ""
			catch { if {$adv ne "null"} { set note [dict get $adv screen_summary] } }
			catch {
				if {$adv ne "null" && [dict get $adv diagnosis] ne ""} {
					append note "\n[dict get $adv diagnosis]"
				}
			}
			set has_advice [expr {[string trim $note] ne ""}]
			if {!$has_advice} { set note "No advice yet for this shot - tap Get advice to dial it in." }
			set note [::crema::trim_words $note 560]
			catch { dui item config $page shot_note -text $note }
			# offer Get advice (none yet) or Apply (advice that changes something)
			set apply_ok 0
			if {$has_advice} {
				set data(advice) $adv
				catch {
					set gt ""; catch { set gt [dict get $adv actions grind target] }
					set tc ""; catch { set tc [dict get $adv actions temperature_c] }
					set dg ""; catch { set dg [dict get $adv actions dose_g] }
					set yg ""; catch { set yg [dict get $adv actions target_yield_g] }
					set pa "keep"; catch { set pa [dict get $adv profile action] }
					if {([string is double -strict $gt] && $gt != $::settings(grinder_setting)) ||
						[string is double -strict $tc] || [string is double -strict $dg] ||
						[string is double -strict $yg] || $pa in {switch create}} {
						set apply_ok 1
					}
				}
			}
			catch { dui item config $page shot_getadvice* -state [expr {$has_advice ? "hidden" : "normal"}] }
			catch { dui item config $page shot_rerun* -state [expr {$has_advice ? "normal" : "hidden"}] }
			catch { dui item config $page shot_disagree* -state [expr {$has_advice ? "normal" : "hidden"}] }
			catch { dui item config $page shot_apply* -state [expr {$apply_ok ? "normal" : "hidden"}] }

			# replay the stored curves
			set T {}; set P {}; set F {}; set W {}
			set elapsed {}; set pres {}; set flow {}; set wf {}
			catch { set elapsed [dict get $p elapsed] }
			catch { set pres [dict get $p pressure] }
			catch { set flow [dict get $p flow] }
			catch { set wf [dict get $p weight_flow] }
			set bt {}
			catch { set bt [dict get $p basket_temp] }
			set C {}
			for {set i 0} {$i < [llength $elapsed]} {incr i} {
				set t [lindex $elapsed $i]
				if {![string is double -strict $t]} { continue }
				lappend T $t
				foreach {src dst} [list $pres P $flow F $wf W] {
					set v [lindex $src $i]
					if {![string is double -strict $v]} { set v 0 }
					lappend $dst $v
				}
				set c [lindex $bt $i]
				lappend C [expr {[string is double -strict $c] ? $c / 10.0 : 0}]
			}
			if {[llength $T] > 1} {
				crema_hist_time set $T
				crema_hist_pressure set $P
				crema_hist_flow set $F
				crema_hist_weight set $W
				catch { crema_hist_temp set $C }
			}
		} err]} {
			catch { dui item config $page shot_note -text "Could not load shot ($err)" }
		}
	}
}
