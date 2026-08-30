# Crema local shot memory — replaces the Mac server's database when running
# standalone. Each rated shot is one file under the writable homedir. Records
# are stored as Tcl dict strings (a dict is a valid Tcl list, so it round-trips
# through the filesystem without any JSON serializer) and hold everything the
# advisor prompt, dashboard, and detail page need.

namespace eval ::crema::store {
	variable subdir "crema_shots"

	proc dir {} {
		set d "[homedir]/$::crema::store::subdir"
		catch { file mkdir $d }
		return $d
	}

	# Build a shot record dict from the live espresso vectors + settings.
	# Called at flow-end (before steam/water can change the vectors).
	proc capture {} {
		set rec [dict create]
		dict set rec id [clock seconds]
		dict set rec created_at [clock format [clock seconds] -format "%Y-%m-%dT%H:%M:%S"]
		dict set rec bean [dict create \
			name [string trim $::settings(bean_type)] \
			roaster [string trim $::settings(bean_brand)] \
			roast_date $::settings(roast_date) \
			roast_level [ifexists ::settings(bean_roast_level) ""]]
		dict set rec grinder [dict create \
			model [ifexists ::crema_settings(grinder_name) $::settings(grinder_model)] \
			setting $::settings(grinder_setting)]
		dict set rec grinder_setting $::settings(grinder_setting)
		dict set rec dose_g $::settings(grinder_dose_weight)
		catch { dict set rec target_yield_g $::settings(final_desired_shot_weight) }
		# pick a REAL profile title, never the literal "Saved" that save_profile
		# transiently leaves in ::settings(profile) right after an AI profile
		# creation (else the shot - and the advisor prompt - would say Profile 'Saved')
		set ptitle ""
		foreach __c [list [ifexists ::settings(profile_title) ""] [ifexists ::settings(profile) ""]] {
			if {$__c ne "" && $__c ne "Saved"} { set ptitle $__c; break }
		}
		dict set rec profile_title $ptitle
		# the real brew temperature (profile target) - the basket_temp curve is a
		# metal-sensor reading that runs much cooler and must NOT be read as brew temp
		dict set rec brew_temp [ifexists ::settings(espresso_temperature) ""]

		# curves from the BLT vectors. pressure_goal/flow_goal are the profile's
		# INTENDED curves - capturing them lets the advisor read intended-vs-actual
		# (did the machine hit the profile?) instead of guessing the profile shape.
		foreach {key vec} {elapsed espresso_elapsed pressure espresso_pressure \
				flow espresso_flow weight_flow espresso_flow_weight \
				pressure_goal espresso_pressure_goal flow_goal espresso_flow_goal \
				basket_temp espresso_temperature_basket} {
			set vals {}
			catch { set vals [$vec range 0 end] }
			dict set rec $key $vals
		}
		# final yield (grams) - PROVISIONAL at flow-end; the settled drink_weight
		# overrides this at rating time (advisor::settled_final_yield). Mirror how
		# de1app captures the shot "out" (shot.tcl): the scale weight, falling back
		# to pour_volume ONLY when there is no scale reading. Here at flow-end the
		# best THIS-shot value is the live cumulative scale vector `espresso_weight`
		# (fed from ::de1(scale_weight)); ::settings(drink_weight) may still hold the
		# PREVIOUS shot until after_flow_complete fires, so we don't read it yet.
		#   NO cross-check band. The old code read a non-existent vector
		#   (`espresso_weight_raw`) so EVERY shot silently fell back to pour_volume -
		#   a mL VOLUME estimate that balloons on gushers (the 60.9g the barista
		#   saw) - and a later band even downgraded good scale weights to it. Gone.
		set fy ""
		catch {
			set wv [lindex [espresso_weight range end end] 0]
			if {[string is double -strict $wv] && $wv > 0.3 && $wv < 500} { set fy $wv }
		}
		if {$fy eq ""} { set fy [ifexists ::de1(pour_volume) ""] }
		# round - pour_volume comes as a long raw float (e.g. 37.50043202304)
		if {[string is double -strict $fy]} { set fy [format %.1f $fy] }
		dict set rec final_yield_g $fy
		set dur ""
		catch { set dur [lindex [dict get $rec elapsed] end] }
		dict set rec duration_s $dur
		return $rec
	}

	proc file_for {id} { return "[dir]/${id}.shot" }

	proc delete {id} { catch { file delete [file_for $id] } }

	proc save {rec} {
		set id [dict get $rec id]
		if {[catch { write_file [file_for $id] $rec } err]} {
			msg -ERROR "crema-store: save failed: $err"
			return 0
		}
		return 1
	}

	proc load_one {fn} {
		set rec [dict create]
		# decode as UTF-8 (records hold chars like ° from the advice text);
		# read_binary_file returns raw bytes, so ° would render as "Â°" otherwise
		catch { set rec [encoding convertfrom utf-8 [read_binary_file $fn]] }
		return $rec
	}

	proc get {id} { return [load_one [file_for $id]] }

	# newest-first list of records, optionally filtered by bean name
	proc recent {limit {bean ""}} {
		set files {}
		catch { set files [glob -nocomplain "[dir]/*.shot"] }
		# filename is <clock>.shot -> numeric sort desc
		set ids {}
		foreach f $files {
			set b [file rootname [file tail $f]]
			if {[string is integer -strict $b]} { lappend ids $b }
		}
		set ids [lsort -integer -decreasing $ids]
		set out {}
		foreach id $ids {
			set rec [get $id]
			if {![dict size $rec]} { continue }
			if {$bean ne ""} {
				set bn ""
				catch { set bn [dict get $rec bean name] }
				if {$bn ne $bean} { continue }
			}
			lappend out $rec
			if {[llength $out] >= $limit} { break }
		}
		return $out
	}

	proc count {} {
		set files {}
		catch { set files [glob -nocomplain "[dir]/*.shot"] }
		return [llength $files]
	}
}
