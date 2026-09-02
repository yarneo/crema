# Crema self-test: full simulated shot -> questionnaire -> advisor round-trip.
# Only loaded when the CREMA_SELFTEST env var is set. Desktop simulator only.

namespace eval ::crema::selftest {
	variable started 0
	variable deadline 0

	proc log {m} { msg -INFO "CREMA-SELFTEST: $m" }

	proc begin {} {
		variable deadline
		set deadline [expr {[clock seconds] + 300}]
		if {[info exists ::env(CREMA_STANDALONE)]} {
			log "STANDALONE mode: direct provider via mock endpoint"
			set ::crema_settings(ai_mode) standalone
			set ::crema_settings(ai_provider) anthropic
			set ::crema_settings(ai_base_url) "http://localhost:8877"
			set ::crema_settings(ai_api_key) "test-key"
			set ::crema_settings(ai_model) "claude-opus-4-8"
			catch { file delete {*}[glob -nocomplain "[::crema::store::dir]/*.shot"] }
		} else {
			set ::crema_settings(ai_mode) server
		}
		log "starting simulated espresso"
		set ::settings(bluetooth_address) ""
		set ::settings(bean_brand) "Selftest Roasters"
		set ::settings(bean_type) "Sim Guji"
		set ::settings(roast_date) "2026-07-01"
		set ::settings(grinder_model) "Lagom 01 (102mm Mizen)"
		if {$::settings(grinder_setting) in {0 {}}} { set ::settings(grinder_setting) 5.4 }
		catch { start_espresso } err
		if {$err ne ""} { log "start_espresso err: $err" }
		after 3000 ::crema::selftest::watch_qa
	}

	proc watch_qa {} {
		variable deadline
		if {[clock seconds] > $deadline} { log "FAIL: timed out waiting for QA page"; save_evidence; exit 1 }
		set page ""
		catch { set page [dui page current] }
		if {$page eq "crema_qa"} {
			log "QA page loaded - answering"
			after 1000 ::crema::selftest::answer
			return
		}
		after 2000 ::crema::selftest::watch_qa
	}

	proc answer {} {
		::crema::pages::crema_qa::pick taste salty
		::crema::pages::crema_qa::pick body thin
		::crema::pages::crema_qa::pick flow even
		::crema::pages::crema_qa::pick aftertaste short
		::crema::pages::crema_qa::pick enjoyment 2
		after 1000 {
			::crema::selftest::log "submitting questionnaire"
			::crema::pages::crema_qa::submit
			after 2000 ::crema::selftest::watch_advice
		}
	}

	proc watch_advice {} {
		variable deadline
		if {[clock seconds] > $deadline} { log "FAIL: timed out waiting for advice"; save_evidence; exit 1 }
		catch { log "trace page=[dui page current] status=$::crema::advisor::status" }
		set status $::crema::advisor::status
		if {$status eq "done"} {
			log "PASS: advice = $::crema::advisor::advice(summary)"
			after 1000 ::crema::selftest::check_undo
			return
		}
		if {$status eq "error"} {
			set err ""; catch { set err $::crema::advisor::advice(error) }
			log "FAIL: advisor error: $err"
			save_evidence
			after 1000 { exit 1 }
			return
		}
		after 3000 ::crema::selftest::watch_advice
	}

	# The fields Apply can move and Undo must put back. Kept as a flat list so
	# a mismatch names the field rather than dumping two opaque blobs.
	proc machine_state {} {
		set out [dict create]
		dict set out profile [ifexists ::settings(profile_title) ""]
		foreach k {grinder_setting grinder_dose_weight final_desired_shot_weight
		           final_desired_shot_weight_advanced espresso_temperature} {
			dict set out $k [ifexists ::settings($k) ""]
		}
		catch { dict set out steps [ifexists ::settings(advanced_shot) ""] }
		return $out
	}

	proc item_state {tag} {
		set state "absent"
		catch {
			foreach id [.can find withtag $tag] { set state [.can itemcget $id -state] }
		}
		return $state
	}

	# Apply is the one action that writes to the machine, and Undo is the only
	# way back. Both are exercised here so a regression cannot reach the tablet
	# silently.
	proc check_undo {} {
		variable undo_before
		set before [machine_state]
		# Stored before anything is scheduled, so the delayed check below cannot
		# read it half-set.
		set undo_before $before
		log "UNDO: before apply -> $before"

		if {[catch { ::crema::pages::crema_advice::apply_all } err]} {
			log "UNDOFAIL: apply_all raised: $err"
			save_evidence
			after 1000 ::crema::selftest::to_dashboard
			return
		}

		set applied [machine_state]
		log "UNDO: after apply  -> $applied"
		if {$applied eq $before} {
			log "UNDO: note - apply changed nothing, so this run only proves undo is harmless"
		}
		log "UNDO: undo button state = [item_state adv_undo]"

		after 1500 {
			if {[catch { ::crema::pages::crema_advice::undo_press } err]} {
				::crema::selftest::log "UNDOFAIL: undo_press raised: $err"
				::crema::selftest::save_evidence
				after 1000 ::crema::selftest::to_dashboard
				return
			}

			set after_undo [::crema::selftest::machine_state]
			::crema::selftest::log "UNDO: after undo   -> $after_undo"

			set before2 [::crema::selftest::restored_target]
			set bad {}
			foreach k [dict keys $before2] {
				if {[dict get $after_undo $k] ne [dict get $before2 $k]} { lappend bad $k }
			}
			if {[llength $bad]} {
				::crema::selftest::log "UNDOFAIL: not restored: [join $bad {, }]"
			} elseif {[::crema::selftest::item_state adv_undo] ne "hidden"} {
				::crema::selftest::log "UNDOFAIL: undo button still visible after undo"
			} else {
				::crema::selftest::log "UNDOPASS: every field restored and the button hid itself"
			}
			after 1000 ::crema::selftest::to_dashboard
		}
	}

	variable undo_before {}
	proc restored_target {} { variable undo_before; return $undo_before }

	proc to_dashboard {} {
		log "checking dashboard (via home, like a real user)"
		catch { ::crema::pages::crema_advice::done }
		after 2000 { catch { dui page load crema_dashboard } }
		after 8000 ::crema::selftest::check_dashboard
	}

	proc check_dashboard {} {
		set page ""
		catch { set page [dui page current] }
		set row0 ""
		catch {
			foreach id [.can find withtag row_0_bean] { set row0 [.can itemcget $id -text] }
		}
		set status_txt ""
		catch {
			foreach id [.can find withtag dash_status] { set status_txt [.can itemcget $id -text] }
		}
		log "DASHBOARD: page=$page status='$status_txt' row0_bean='$row0'"
		if {$page eq "crema_dashboard" && $row0 ne ""} {
			log "DASHPASS"
		} else {
			log "DASHFAIL"
		}
		if {[info exists ::env(CREMA_STANDALONE)]} {
			set n 0
			catch { set n [::crema::store::count] }
			if {$n > 0} { log "STOREPASS: $n shot(s) persisted locally" } else { log "STOREFAIL: nothing in local store" }
		}
		after 2000 { exit 0 }
	}

	proc save_evidence {} {
		catch {
			set page ""
			catch { set page [dui page current] }
			log "evidence: current page=$page"
			foreach id [.can find all] {
				set tags [.can gettags $id]
				if {[string match "*crema*" $tags] || [string match "*adv_*" $tags]} {
					set state ""; catch { set state [.can itemcget $id -state] }
					set text "";  catch { set text [string range [.can itemcget $id -text] 0 60] }
					log "item $id type=[.can type $id] state=$state bbox=[.can bbox $id] text='$text'"
				}
			}
		}
	}
}

after 20000 ::crema::selftest::begin
