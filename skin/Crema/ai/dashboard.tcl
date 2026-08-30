# crema_dashboard — recent shot performance, fed by the advisor server
# (which holds taste answers + advice; local history lacks those).

namespace eval ::crema::pages::crema_dashboard {
	variable widgets; array set widgets {}
	variable data;    array set data {}
	variable max_rows 8
	variable row_ids {}
	variable all_shots {}
	variable page_off 0

	proc open_row {r} {
		variable row_ids
		if {$r < [llength $row_ids]} {
			::crema::pages::crema_shot::open [lindex $row_ids $r]
		}
	}

	proc setup {} {
		variable max_rows
		set page [namespace tail [namespace current]]

		dui add dtext $page 160 120 -text "Recent shots" \
			-font_family "Mazzard SemiBold" -font_size 42 \
			-fill [::theme background_text] -anchor w

		dui add dtext $page 160 220 -text "" -tags dash_status -font_size 18 \
			-fill [::theme muted] -anchor w -width 2200

		# column headers
		set cols {date "DATE" bean "BEAN" grind "GRIND" time "TIME" inout "IN › OUT" taste "TASTE" stars "SCORE"}
		set xs   {160 540 1060 1280 1500 2060 2320}
		set i 0
		foreach {key label} $cols {
			dui add dtext $page [lindex $xs $i] 300 -text $label \
				-font_family "Mazzard Medium" -font_size 14 -fill [::theme muted] \
				-anchor w -tags hdr_$key
			incr i
		}

		for {set r 0} {$r < $max_rows} {incr r} {
			set y [expr {380 + $r * 130}]
			set i 0
			foreach key {date bean grind time inout taste stars} {
				set fill [::theme background_text]
				if {$key eq "stars"} { set fill [::theme accent] }
				if {$key eq "date"}  { set fill [::theme muted] }
				dui add dtext $page [lindex $xs $i] $y -text "" -font_size 19 \
					-fill $fill -anchor w -tags [list row_${r}_$key row_${r}_tap]
				incr i
			}
			dui add dtext $page 160 [expr {$y + 50}] -text "" -font_size 14 \
				-fill [::theme muted] -anchor w -width 2240 -tags [list row_${r}_advice row_${r}_tap]
			# whole row opens the shot detail page
			dui add dbutton $page 140 [expr {$y - 30}] 2420 [expr {$y + 88}] \
				-tags [list rowhit_$r row_${r}_tap] -fill {} -label "" \
				-command [list ::crema::pages::crema_dashboard::open_row $r]
			catch { .can bind row_${r}_tap [::dui::platform::button_press] \
				[list ::crema::pages::crema_dashboard::open_row $r] }
		}

		# paging - the row widgets are a fixed page of 8; these step through history
		dui add dbutton $page 1600 1395 1980 1470 -tags dash_newer -shape outline \
			-initial_state hidden -outline [::theme card_outline] -arc_offset 24 \
			-label "‹ Newer" -label_pos {0.5 0.5} -label_font_size 19 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_dashboard::page_newer
		dui add dbutton $page 2020 1395 2400 1470 -tags dash_older -shape outline \
			-initial_state hidden -outline [::theme card_outline] -arc_offset 24 \
			-label "Older ›" -label_pos {0.5 0.5} -label_font_size 19 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_dashboard::page_older

		::crema::pages::add_nav $page shots
	}

	proc show {args} {
		clear
		variable page_off ; set page_off 0
		set page [namespace tail [namespace current]]
		dui item config $page dash_status -text "Loading shots..."
		# pull a deep slice once, then page through it client-side
		::crema::history::recent 400 ::crema::pages::crema_dashboard::loaded
	}

	proc clear {} {
		variable max_rows
		set page [namespace tail [namespace current]]
		for {set r 0} {$r < $max_rows} {incr r} {
			foreach key {date bean grind time inout taste stars advice} {
				catch { dui item config $page row_${r}_$key -text "" }
			}
		}
	}

	proc loaded {shots} {
		variable all_shots
		set all_shots $shots
		render_page
	}

	proc render_page {} {
		variable all_shots ; variable page_off ; variable max_rows
		set page [namespace tail [namespace current]]
		if {[catch {
			set total [llength $all_shots]
			if {$page_off >= $total && $total > 0} {
				set page_off [expr {(($total - 1) / $max_rows) * $max_rows}]
			}
			render [lrange $all_shots $page_off [expr {$page_off + $max_rows - 1}]]
			if {$total > 0} {
				set from [expr {$page_off + 1}]
				set to [expr {min($page_off + $max_rows, $total)}]
				catch { dui item config $page dash_status -text "Showing $from-$to of $total" }
			}
			catch { dui item config $page dash_newer* -state [expr {$page_off > 0 ? "normal" : "hidden"}] }
			catch { dui item config $page dash_older* -state [expr {$page_off + $max_rows < $total ? "normal" : "hidden"}] }
		} err]} {
			catch { dui item config $page dash_status -text "Could not load shots ($err)" }
		}
	}

	proc page_newer {} {
		variable page_off ; variable max_rows
		set page_off [expr {max(0, $page_off - $max_rows)}]
		render_page
	}
	proc page_older {} {
		variable page_off ; variable max_rows ; variable all_shots
		if {$page_off + $max_rows < [llength $all_shots]} { incr page_off $max_rows }
		render_page
	}

	proc stars {n} {
		if {![string is integer -strict $n]} { return "-" }
		return "[string repeat ★ $n][string repeat ☆ [expr {5 - $n}]]"
	}

	# json2dict renders JSON null as the string "null"; blank it for display
	proc nn {v} {
		if {$v eq "null"} { return "" }
		return $v
	}

	proc render {shots} {
		variable max_rows
		variable row_ids
		set page [namespace tail [namespace current]]
		dui item config $page dash_status -text "[llength $shots] recent shots"
		set row_ids {}
		foreach shot $shots {
			lappend row_ids [dict get $shot id]
		}
		set r 0
		foreach shot $shots {
			if {$r >= $max_rows} { break }
			set p [dict get $shot payload]
			set a {}
			catch { set a [dict get $p answers] }
			set adv {}
			catch { set adv [dict get $shot advice] }

			set date ""
			catch { set date [string map {T " "} [string range [dict get $shot created_at] 5 15]] }
			set bean "";  catch { set bean [string range [nn [dict get $p bean name]] 0 24] }
			set grind ""; catch { set grind [nn [dict get $p grinder setting]] }
			set dur ""
			catch {
				set d [dict get $p duration_s]
				if {[string is double -strict $d] && $d > 0} { set dur "[format %.0f $d]s" }
			}
			set inout ""
			catch {
				set din [dict get $p dose_g]; set dout [dict get $p final_yield_g]
				# only render a physically-sane yield; a broken capture (0, or a
				# wild >90 reading) shows as a dose-only line rather than a fake ratio
				if {[string is double -strict $din] && $din > 0} {
					if {[string is double -strict $dout] && $dout > 0.3 && $dout < 90} {
						set inout "[format %.1f $din] › [format %.1f $dout]g · 1:[format %.1f [expr {$dout/double($din)}]]"
					} else {
						set inout "[format %.1f $din]g in"
					}
				}
			}
			set taste ""; catch { set taste [nn [dict get $a taste_balance]] }
			set enj "";   catch { set enj [nn [dict get $a enjoyment]] }
			set summary ""
			catch { set summary [string range [nn [dict get $adv screen_summary]] 0 140] }

			dui item config $page row_${r}_date  -text $date
			dui item config $page row_${r}_bean  -text $bean
			dui item config $page row_${r}_grind -text $grind
			dui item config $page row_${r}_time  -text $dur
			dui item config $page row_${r}_inout -text $inout
			dui item config $page row_${r}_taste -text $taste
			dui item config $page row_${r}_stars -text [stars $enj]
			dui item config $page row_${r}_advice -text $summary
			incr r
		}
		if {$r == 0} {
			dui item config $page dash_status -text "No shots recorded yet - pull one!"
		}
	}
}
