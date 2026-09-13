# crema_dashboard — recent shot performance, fed by the advisor server
# (which holds taste answers + advice; local history lacks those).

namespace eval ::crema::pages::crema_dashboard {
	variable widgets; array set widgets {}
	variable data;    array set data {}
	variable max_rows 5
	variable row_ids {}
	variable all_shots {}
	variable page_off 0
	# the slice of history currently on screen; the trail follows it
	variable page_shots {}
	# which bag on that page the trail is showing ({} = the newest row's)
	variable trail_key {}

	proc open_row {r} {
		variable row_ids
		if {$r < [llength $row_ids]} {
			::crema::pages::crema_shot::open [lindex $row_ids $r]
		}
	}

	proc setup {} {
		variable max_rows
		set page [namespace tail [namespace current]]

		dui add dtext $page 120 120 -text "Recent shots" \
			-font_family "Mazzard SemiBold" -font_size 38 \
			-fill [::theme background_text] -anchor w

		dui add dtext $page 120 220 -text "" -tags dash_status -font_size 19 \
			-fill [::theme muted] -anchor w -width 2200

		# ---- shot cards -----------------------------------------------------
		# Was a seven-column spreadsheet with star ratings. A card per shot with
		# one headline, one muted meta line and a score chip is how every skin
		# people actually praise presents this, and it survives being read at
		# arm's length.
		for {set r 0} {$r < $max_rows} {incr r} {
			set y [expr {640 + $r * 162}]

			dui add shape round $page 120 $y -bwidth 2320 -bheight 150 \
				-fill [::theme card_fill] -radius 24 -tags row_${r}_card

			# If you alternate coffees day to day, a page holds several bags while
			# the chart above shows one. This marks the rows that chart covers.
			dui add shape round $page 132 [expr {$y + 18}] -bwidth 9 -bheight 114 \
				-radius 4 -fill [::theme accent] -tags row_${r}_bag \
				-initial_state hidden
			dui add dtext $page 180 [expr {$y + 34}] -text "" -font_size 23 \
				-font_family "Mazzard SemiBold" -fill [::theme background_text] \
				-anchor w -width 620 -tags [list row_${r}_bean row_${r}_tap]
			dui add dtext $page 860 [expr {$y + 34}] -text "" -font_size 27 \
				-font_family "Mazzard SemiBold" -fill [::theme background_text] \
				-anchor w -tags [list row_${r}_inout row_${r}_tap]

			dui add dtext $page 180 [expr {$y + 78}] -text "" -font_size 15 \
				-fill [::theme muted] -anchor w -width 1900 \
				-tags [list row_${r}_meta row_${r}_tap]
			dui add dtext $page 180 [expr {$y + 120}] -text "" -font_size 15 \
				-fill [::theme muted] -anchor w -width 1900 \
				-tags [list row_${r}_advice row_${r}_tap]

			# score chip; its fill is set per shot so a good one reads at a glance
			dui add shape round $page 2170 [expr {$y + 34}] -bwidth 190 -bheight 68 \
				-fill [::theme button] -radius 20 -tags row_${r}_chip
			dui add dtext $page 2265 [expr {$y + 68}] -text "" -font_size 22 \
				-font_family "Mazzard SemiBold" -fill [::theme muted] \
				-anchor center -justify center -tags [list row_${r}_score row_${r}_tap]

			dui add dbutton $page 120 $y 2440 [expr {$y + 150}] \
				-tags [list rowhit_$r row_${r}_tap] -fill {} -label "" \
				-command [list ::crema::pages::crema_dashboard::open_row $r]
			catch { .can bind row_${r}_tap [::dui::platform::button_press] \
				[list ::crema::pages::crema_dashboard::open_row $r] }
		}

		# ---- dial-in trail ------------------------------------------------
		# The one chart only this skin can draw: every other skin lists shots,
		# which tells you what happened. Pairing each change with the score that
		# followed it tells you whether it is working.
		dui add shape round $page 120 270 -bwidth 2320 -bheight 340 \
			-fill [::theme card_fill] -radius 24 -tags trail_card
		dui add dtext $page 160 320 -text "" -tags trail_title \
			-font_family "Mazzard SemiBold" -font_size 22 \
			-fill [::theme background_text] -anchor w
		dui add dtext $page 2400 320 -text "" -tags trail_hint -font_size 16 \
			-fill [::theme muted] -anchor e
		dui add dbutton $page 120 282 1400 358 -tags trail_switch -fill {} -label "" \
			-command ::crema::pages::crema_dashboard::cycle_trail_bag

		# paging - the row widgets are a fixed page of 8; these step through history
		dui add dbutton $page 1960 165 2170 255 -tags dash_newer -shape outline \
			-initial_state hidden -outline [::theme card_outline] -arc_offset 24 \
			-label "‹ Newer" -label_pos {0.5 0.5} -label_font_size 19 \
			-label_fill [::theme background_text] \
			-command ::crema::pages::crema_dashboard::page_newer
		dui add dbutton $page 2210 165 2440 255 -tags dash_older -shape outline \
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

	# ---- trail drawing ----------------------------------------------------
	# Raw canvas items, tagged with the page so DUI hides them on the way out,
	# and deleted before every redraw so paging cannot leave ghosts behind.
	proc trail_clear {} {
		catch { .can delete crema_trail }
	}

	# ifdget lives in ::crema::llm and does not resolve from this namespace;
	# a local one keeps the trail from depending on the advisor's internals.
	proc dget {d key {default ""}} {
		if {[catch {dict get $d $key} v]} { return $default }
		if {$v eq "" || $v eq "null"} { return $default }
		return $v
	}

	# Both take a shot's PAYLOAD, not the shot: a record is
	# {id created_at advice payload}, and everything below lives inside payload.
	# Grind is nested one deeper still, as {grinder {setting ...}}.
	proc trail_grind {p} {
		if {[catch {dict get $p grinder setting} v]} { return "" }
		return [expr {$v eq "null" ? "" : $v}]
	}

	proc trail_change {prev cur} {
		set a [trail_grind $prev]
		set b [trail_grind $cur]
		if {[string is double -strict $a] && [string is double -strict $b] && abs($b - $a) >= 0.001} {
			return [format "grind %s%.3g" [expr {$b > $a ? "+" : "-"}] [expr {abs($b - $a)}]]
		}
		foreach {field label} {brew_temp temp} {
			set a [dget $prev $field]
			set b [dget $cur $field]
			if {![string is double -strict $a] || ![string is double -strict $b]} { continue }
			set d [expr {$b - $a}]
			if {abs($d) < 0.01} { continue }
			return [format "%s %s%.3g" $label [expr {$d > 0 ? "+" : "-"}] [expr {abs($d)}]]
		}
		foreach {field label} {dose_g dose target_yield_g yield} {
			set a [dget $prev $field]
			set b [dget $cur $field]
			if {![string is double -strict $a] || ![string is double -strict $b]} { continue }
			if {abs($b - $a) < 0.01} { continue }
			return [format "%s %g" $label $b]
		}
		set a [dget $prev profile_title]
		set b [dget $cur profile_title]
		if {$a ne $b && $b ne ""} { return [string range $b 0 13] }
		return "repeat"
	}

	proc trail_score {p} {
		set a {}
		catch { set a [dict get $p answers] }
		set v [dget $a enjoyment]
		if {[string is integer -strict $v]} { return $v }
		return ""
	}

	# A BAG, not a bean name: two lots of the same coffee roasted months apart
	# are different coffees, and merging their shots into one trail would draw a
	# convergence that never happened.
	proc bag_key {rec} {
		set n "" ; set d ""
		catch { set n [nn [dict get $rec payload bean name]] }
		catch { set d [nn [dict get $rec payload bean roast_date]] }
		return [list $n $d]
	}

	# The distinct bags on the CURRENT PAGE - at most max_rows of them. Cycling
	# the whole bean library does not survive a hundred beans; cycling what is
	# on screen is bounded by the page and covers the real case, which is
	# alternating two or three coffees day to day.
	proc page_bags {} {
		variable page_shots
		set seen [dict create] ; set out {}
		foreach rec $page_shots {
			set k [bag_key $rec]
			if {[lindex $k 0] eq "" || [dict exists $seen $k]} { continue }
			dict set seen $k 1
			lappend out $k
		}
		return $out
	}

	proc cycle_trail_bag {} {
		variable trail_key
		set bags [page_bags]
		if {[llength $bags] < 2} { return }
		set i [lsearch -exact $bags $trail_key]
		set trail_key [lindex $bags [expr {($i + 1) % [llength $bags]}]]
		render_trail
	}

	# show the edge marker on every visible row belonging to $key
	proc mark_rows {key} {
		variable page_shots ; variable max_rows
		set page [namespace tail [namespace current]]
		for {set r 0} {$r < $max_rows} {incr r} {
			set on 0
			if {$r < [llength $page_shots]} {
				set on [expr {[bag_key [lindex $page_shots $r]] eq $key}]
			}
			catch { dui item config $page row_${r}_bag \
				-state [expr {$on ? "normal" : "hidden"}] }
		}
	}

	proc render_trail {} {
		variable all_shots ; variable page_shots
		set page [namespace tail [namespace current]]
		trail_clear
		catch { dui item config $page trail_title -text "" }
		catch { dui item config $page trail_hint -text "" }
		if {![llength $all_shots]} { return }

		# The trail follows the shots on screen: the newest row's bag. Paging
		# back through history walks you through your bags with no extra
		# control, which is the only thing that still works at a hundred beans.
		variable trail_key
		set bags [page_bags]
		if {![llength $bags]} {
			set anchor [lindex $all_shots 0]
			if {$anchor eq ""} { return }
			set bags [list [bag_key $anchor]]
		}
		if {[lsearch -exact $bags $trail_key] < 0} { set trail_key [lindex $bags 0] }
		set key $trail_key
		set bean [lindex $key 0]
		if {$bean eq ""} { return }

		# is this name ambiguous - the same coffee at another roast date?
		set dates [dict create]
		foreach rec $all_shots {
			set k [bag_key $rec]
			if {[lindex $k 0] eq $bean} { dict set dates [lindex $k 1] 1 }
		}

		set total 0
		set picked {}
		foreach rec $all_shots {
			if {[bag_key $rec] ne $key} { continue }
			set pl ""
			catch { set pl [dict get $rec payload] }
			if {$pl eq ""} { continue }
			incr total
			if {[llength $picked] < 8} { lappend picked $pl }
		}
		set picked [lreverse $picked]

		mark_rows $key
		set label $bean
		set rd [lindex $key 1]
		if {[dict size $dates] > 1 && $rd ne ""} { append label "  ·  roasted $rd" }
		if {[llength $bags] > 1} { append label "   ›" }
		catch { dui item config $page trail_title -text "Dial-in · $label" }
		if {[llength $picked] < 2} {
			catch { dui item config $page trail_hint -text "needs a few rated shots" }
			return
		}

		set rated 0
		foreach rec $picked { if {[trail_score $rec] ne ""} { incr rated } }
		if {$rated < 2} {
			catch { dui item config $page trail_hint -text "rate your shots to see this" }
			return
		}
		if {$total > [llength $picked]} {
			set htxt "last [llength $picked] of $total shots · $rated rated"
		} else {
			set htxt "$total shots · $rated rated"
		}
		catch { dui item config $page trail_hint -text $htxt }

		set x0 300 ; set x1 2320 ; set ytop 386 ; set ybot 520
		# unrated shots get their own rail below the 1-5 band, so a shot you
		# have not scored is visible as a gap rather than silently dropped
		set yun [expr {$ybot + 36}]
		set n [llength $picked]
		set step [expr {$n > 1 ? double($x1 - $x0) / ($n - 1) : 0}]
		set sy [expr {double($ybot - $ytop) / 4.0}]

		# Where a shot is worth serving. A stippled band reads as noise on a dark
		# ground — Tk has no alpha, so a dashed guide line says the same thing
		# without the dotty texture.
		set y4 [expr {$ytop + $sy}]
		.can create line [rescale_x_skin $x0] [rescale_y_skin $y4] \
			[rescale_x_skin $x1] [rescale_y_skin $y4] \
			-fill [::theme grid_line] -width 2 -dash {3 14} \
			-tag [list $page crema_trail]
		.can create text [rescale_x_skin $x1] [rescale_y_skin 358] \
			-text "– –  dialled in" -fill [::theme muted] -anchor e -font Helv_6 \
			-tag [list $page crema_trail]
		.can create text [rescale_x_skin [expr {$x0 - 30}]] [rescale_y_skin $ytop] \
			-text "5" -fill [::theme muted] -anchor e -font Helv_6 \
			-tag [list $page crema_trail]
		.can create text [rescale_x_skin [expr {$x0 - 30}]] [rescale_y_skin $ybot] \
			-text "1" -fill [::theme muted] -anchor e -font Helv_6 \
			-tag [list $page crema_trail]

		# Segment by segment, not one smoothed polyline: an unrated shot in
		# between is a break in the evidence, so that segment is dashed. A
		# smooth curve through it would assert a trend we did not measure.
		set li "" ; set ls ""
		set i 0
		foreach rec $picked {
			set sc [trail_score $rec]
			if {$sc eq ""} { incr i ; continue }
			if {$li ne ""} {
				set dash {}
				if {$i - $li > 1} { set dash [list -dash {10 10}] }
				.can create line \
					[rescale_x_skin [expr {$x0 + $li * $step}]] \
					[rescale_y_skin [expr {$ybot - ($ls - 1) * $sy}]] \
					[rescale_x_skin [expr {$x0 + $i * $step}]] \
					[rescale_y_skin [expr {$ybot - ($sc - 1) * $sy}]] \
					-fill [::theme accent] -width 5 {*}$dash \
					-tag [list $page crema_trail]
			}
			set li $i ; set ls $sc
			incr i
		}

		set prev "" ; set prev_score "" ; set i 0
		foreach rec $picked {
			set cx [expr {$x0 + $i * $step}]
			set sc [trail_score $rec]

			if {$sc ne ""} {
				set colour [::theme muted]
				if {$prev_score ne ""} {
					if {$sc > $prev_score} { set colour [::theme primary] }
					if {$sc < $prev_score} { set colour [::theme weight] }
				}
				set cy [expr {$ybot - ($sc - 1) * $sy}]
				set r 14
				set fill [expr {$sc >= 4 ? [::theme accent] : [::theme card_fill]}]
				.can create oval [rescale_x_skin [expr {$cx - $r}]] [rescale_y_skin [expr {$cy - $r}]] \
					[rescale_x_skin [expr {$cx + $r}]] [rescale_y_skin [expr {$cy + $r}]] \
					-fill $fill -outline $colour -width 4 -tag [list $page crema_trail]
				set prev_score $sc
			} else {
				# hollow ring on the unrated rail: the shot happened, the
				# evidence is missing, and tapping the row below fixes that
				set r 11
				.can create oval [rescale_x_skin [expr {$cx - $r}]] [rescale_y_skin [expr {$yun - $r}]] \
					[rescale_x_skin [expr {$cx + $r}]] [rescale_y_skin [expr {$yun + $r}]] \
					-fill "" -outline [::theme muted] -width 3 -tag [list $page crema_trail]
			}

			set lbl [expr {$prev eq "" ? "start" : [trail_change $prev $rec]}]
			.can create text [rescale_x_skin $cx] [rescale_y_skin 592] \
				-text $lbl -fill [expr {$lbl in {start repeat} ? [::theme muted] : [::theme accent]}] \
				-anchor center -font Helv_7 -tag [list $page crema_trail]

			set prev $rec
			incr i
		}

	}

	proc clear {} {
		variable max_rows
		set page [namespace tail [namespace current]]
		trail_clear
		for {set r 0} {$r < $max_rows} {incr r} {
			foreach key {bean inout meta advice score} {
				catch { dui item config $page row_${r}_$key -text "" }
			}
			catch { dui item config $page row_${r}_card -state hidden }
			catch { dui item config $page row_${r}_bag -state hidden }
			catch { dui item config $page row_${r}_chip -state hidden }
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
			variable page_shots
			set page_shots [lrange $all_shots $page_off [expr {$page_off + $max_rows - 1}]]
			variable trail_key ; set trail_key {}
			render $page_shots
			catch { render_trail }
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
			# one line only: at this width and size, more than this wraps into the
			# card below it
			catch {
				set summary [nn [dict get $adv screen_summary]]
				# one line only at this width; cut back to a word boundary so the
				# card never ends mid-word ("...cap the fin")
				if {[string length $summary] > 104} {
					set cut [string range $summary 0 103]
					set sp [string last " " $cut]
					if {$sp > 60} { set cut [string range $cut 0 [expr {$sp - 1}]] }
					set summary "[string trimright $cut {,.;:}] ..."
				}
			}

			# one muted line instead of five columns
			set meta {}
			if {$date ne ""}  { lappend meta $date }
			if {$dur ne ""}   { lappend meta $dur }
			if {$grind ne ""} { lappend meta "grind $grind" }
			if {$taste ne ""} { lappend meta $taste }

			catch { dui item config $page row_${r}_card -state normal }
			dui item config $page row_${r}_bean  -text $bean
			dui item config $page row_${r}_inout -text $inout
			dui item config $page row_${r}_meta  -text [join $meta "  ·  "]
			dui item config $page row_${r}_advice -text $summary

			# An unrated shot shows no chip at all rather than a grey zero: it is
			# a prompt to rate it, not a score of nothing.
			if {[string is integer -strict $enj]} {
				catch { dui item config $page row_${r}_chip -state normal }
				set chip [expr {$enj >= 4 ? [::theme accent] : [::theme button]}]
				set ink  [expr {$enj >= 4 ? [::theme accent_text] : [::theme background_text]}]
				catch { dui item config $page row_${r}_chip -fill $chip }
				dui item config $page row_${r}_score -text "$enj/5" -fill $ink
			} else {
				catch { dui item config $page row_${r}_chip -state hidden }
				dui item config $page row_${r}_score -text "rate ›" -fill [::theme accent]
			}
			incr r
		}
		if {$r == 0} {
			dui item config $page dash_status -text "No shots recorded yet - pull one!"
		}
	}
}
