# Dev screenshot rig: capture every Crema page to PNG using the bundled
# TkImg window capture (no OS screen-recording permission needed).
# Activated by CREMA_DEVSHOT=1; writes /tmp/crema_pages/*.png then exits.

namespace eval ::crema::devshot {
	variable outdir "/tmp/crema_pages"
	variable queue {}

	proc log {m} { msg -INFO "CREMA-DEVSHOT: $m" }

	proc snap {name} {
		variable outdir
		if {[catch {
			package require img::window
			update idletasks
			update
			set img [image create photo -format window -data .can]
			$img write "$outdir/$name.png" -format png
			image delete $img
			log "captured $name -> $outdir/$name.png [file size $outdir/$name.png] bytes"
		} err]} {
			log "capture $name FAILED: $err"
		}
	}

	proc fake_advice {} {
		set ::crema::advisor::status "done"
		array unset ::crema::advisor::advice
		array set ::crema::advisor::advice {
			summary "Grind 0.3 finer (5.4 > 5.1), drop dose to 16g at 92C and try the gentle flow profile - this Guji wants less pressure."
			diagnosis "Shot ran 22s and finished thin and sour - classic under-extraction. Flow was even, so puck prep is fine; the grind is simply too coarse for this natural Ethiopian."
			confidence "high"
			grind_delta -0.3
			grind_target 5.1
			dose_g 16.0
			yield_g 36
			temp_c 92
			profile_action "create"
			profile_switch_to ""
		}
		set ::crema::advisor::advice(created_profile) [dict create \
			title "Guji gentle flow v1" \
			notes "Long gentle infusion then a flow-profiled decline for a bright natural." \
			target_weight_g 36 \
			steps [list \
				[dict create name Fill temperature 92 seconds 25 pump flow flow 8 \
					transition fast exit_type pressure_over exit_pressure_over 3] \
				[dict create name Infuse temperature 92 seconds 20 pump pressure pressure 3 \
					transition fast] \
				[dict create name Decline temperature 91 seconds 40 pump flow flow 2.0 \
					transition smooth]]]
	}

	proc check_toolbox {} {
		set ok 1
		foreach {desc expr_} {
			dose  {$::settings(grinder_dose_weight) == 16.0}
			yield {$::settings(final_desired_shot_weight) == 36}
			temp  {$::settings(espresso_temperature) == 92}
			title {$::settings(profile_title) eq "AI · Sim Guji"}
			steps {[llength $::settings(advanced_shot)] == 3}
			type  {$::settings(settings_profile_type) eq "settings_2c"}
		} {
			if {![expr $expr_]} { log "TOOLFAIL: $desc"; set ok 0 }
		}
		if {$ok} { log "TOOLPASS: recipe + created profile applied" }
	}

	variable steps {}

	proc step {} {
		variable steps
		if {![llength $steps]} { log "tour done"; after 1000 { exit 0 }; return }
		set steps [lassign $steps action delay]
		catch { uplevel #0 $action }
		after $delay ::crema::devshot::step
	}

	proc run {} {
		variable outdir
		variable steps
		file mkdir $outdir
		if {$::env(CREMA_DEVSHOT) eq "setup"} {
			log "setup wizard capture"
			catch { file delete {*}[glob -nocomplain $outdir/*.png] }
			set steps [list \
				{ dui page load crema_setup } 1500 \
				{ ::crema::devshot::snap 20_setup_anthropic } 200 \
				{ ::crema::pages::crema_setup::pick_provider compatible } 800 \
				{ ::crema::devshot::snap 21_setup_compatible } 200 \
				{ ::crema::pages::crema_setup::pick_provider openai } 800 \
				{ ::crema::devshot::snap 22_setup_openai } 200 \
				{ ::crema::devshot::log "setup tour done" } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "firstrun"} {
			log "first-run boot decision test"
			set steps [list \
				{ if {[::crema::needs_setup]} {
					::crema::devshot::log "FIRSTRUN: needs_setup=1 (correct for fresh device)"
				  } else {
					::crema::devshot::log "FIRSTRUN-FAIL: needs_setup=0 (would skip wizard)"
				  }
				  catch { iconik_wakeup } } 1800 \
				{ ::crema::devshot::log "FIRSTRUN: landed on page=[dui page current]" }  200 \
				{ ::crema::devshot::snap 30_firstrun_boot } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "errtest"} {
			log "advice error-state capture"
			catch { file delete {*}[glob -nocomplain $outdir/*.png] }
			set steps [list \
				{ set ::crema::advisor::pending_answers [dict create id 1 bean [dict create name Guji]]
				  set ::crema::advisor::status "error"
				  array unset ::crema::advisor::advice
				  set ::crema::advisor::advice(error) "Google error (HTTP 429): You exceeded your current quota."
				  set ::crema::advisor::advice_seen 0
				  dui page load crema_advice } 2000 \
				{ ::crema::advisor::update_advice_page } 800 \
				{ ::crema::devshot::snap 40_advice_error } 200 \
				{ set st ""
				  catch { set st [.can itemcget [lindex [.can find withtag adv_retry-btn] 0] -state] }
				  ::crema::devshot::log "RETRYBTN state=$st"
				  ::crema::devshot::log "errtest done" } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "shotbtn"} {
			log "shot-detail Get-advice button test"
			catch { file delete {*}[glob -nocomplain $outdir/*.png] }
			catch { file delete {*}[glob -nocomplain "[::crema::store::dir]/*.shot"] }
			set ::crema_settings(ai_mode) standalone
			set ::crema_settings(ai_api_key) "demo"
			set now [clock seconds]
			set rec [dict create id $now created_at [clock format $now -format "%Y-%m-%dT%H:%M:%S"] \
				bean [dict create name "Ethiopia Guji Uraga" roaster "Onyx" roast_date "2026-07-12"] \
				grinder [dict create model "Lagom 01" setting 5.4] grinder_setting 5.4 \
				dose_g 18.0 target_yield_g 36 final_yield_g 36 duration_s 28 profile_title "Best overall pressure" \
				elapsed {0 4 8 12 18 26} pressure {1 6 9 9 9 9} flow {0 0.6 1.4 1.7 1.9 2.0} \
				weight_flow {0 0 0.6 1.5 2.2 2.6} basket_temp {92 93 93 93 93 93} \
				answers [dict create taste_balance sour body thin flow_look even aftertaste short enjoyment 2]]
			catch { ::crema::store::save $rec }
			set steps [list \
				{ dui page load crema_dashboard } 2500 \
				{ catch { ::crema::pages::crema_dashboard::open_row 0 } } 2500 \
				{ ::crema::devshot::snap 50_shot_noadvice } 200 \
				{ set st ""; catch { set st [.can itemcget [lindex [.can find withtag shot_getadvice-btn] 0] -state] }
				  ::crema::devshot::log "GETADVBTN state=$st"; ::crema::devshot::log "shotbtn done" } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "gallery"} {
			log "forum gallery capture"
			catch { file delete {*}[glob -nocomplain $outdir/*.png] }

			# nice sample data for the brew screen
			set ::settings(bean_brand) "Onyx Coffee Lab"
			set ::settings(bean_type) "Ethiopia Guji Uraga"
			set ::settings(roast_date) "2026-07-12"
			set ::settings(grinder_setting) 5.4
			set ::settings(grinder_dose_weight) 18.0
			set ::settings(final_desired_shot_weight) 36
			set ::settings(profile_title) "Best overall pressure"
			set ::settings(profile) "Best overall pressure"
			set ::crema_settings(grinder_name) "Lagom 01"
			set ::crema_settings(ai_mode) standalone
			set ::crema_settings(ai_api_key) "demo-key-for-status-only"
			set ::crema_settings(server_url) ""
			set ::crema_settings(beans) [list [dict create \
				roaster "Onyx Coffee Lab" name "Ethiopia Guji Uraga" \
				roast "2026-07-12" dose "18.0"]]
			set ::crema_settings(bean_sel) 0

			# seed a few rated shots into the local store for History/Detail
			catch { file delete {*}[glob -nocomplain "[::crema::store::dir]/*.shot"] }
			set el {0 2 4 6 8 10 13 16 19 22 25 28 30 32}
			set pr {0.5 2 5 8 9 9 8.8 8.5 8.2 7.8 7.2 6.5 6 5.8}
			set fl {0 0.3 0.8 1.2 1.6 1.9 2.1 2.2 2.2 2.1 2.0 1.9 1.8 1.8}
			set wf {0 0 0 0.2 0.8 1.4 1.8 2.0 2.1 2.1 2.0 1.9 1.8 1.7}
			set bt {90 91 92 92.5 93 93 92.8 92.5 92.3 92 92 91.8 91.5 91.5}
			set now [clock seconds]
			set demos {
				{5.4 18.0 36.2 32 balanced clean 4 "Dialed in - hold here." "Even 9-bar plateau and a clean 2:1 in 32s. Sweetness peaked; no change needed."}
				{5.6 18.0 33.5 26 sour short 2 "Grind 0.3 finer next shot." "Ran fast at 26s and finished sour - under-extracted. Try 5.3 and aim for 34-36g."}
				{5.2 18.0 38.0 38 bitter astringent 3 "Coarsen 0.2 and pull shorter." "Slow 38s pull, a touch bitter. Back off to 5.4 and stop nearer 36g."}
			}
			set idx 0
			foreach d $demos {
				lassign $d g dose fy dur taste finish enj summ diag
				set id [expr {$now - $idx * 7200}]
				set rec [dict create \
					id $id \
					created_at [clock format $id -format "%Y-%m-%dT%H:%M:%S"] \
					bean [dict create name "Ethiopia Guji Uraga" roaster "Onyx Coffee Lab" roast_date "2026-07-12"] \
					grinder [dict create model "Lagom 01" setting $g] \
					grinder_setting $g dose_g $dose target_yield_g 36 final_yield_g $fy \
					duration_s $dur profile_title "Best overall pressure" \
					elapsed $el pressure $pr flow $fl weight_flow $wf basket_temp $bt \
					answers [dict create taste_balance $taste body medium flow_look even aftertaste $finish enjoyment $enj] \
					advice [dict create screen_summary $summ diagnosis $diag]]
				catch { ::crema::store::save $rec }
				incr idx
			}

			set steps [list \
				{ ::crema::go_home
				  catch { ::crema::pages::crema_home::refresh_texts }
				  catch { ::crema::pages::crema_home::refresh_status }
				  catch { ::crema::pages::crema_home::ping_advisor } } 2600 \
				{ ::crema::devshot::snap 01_brew_screen } 200 \
				{ set ::settings(bluetooth_address) ""; catch { start_espresso } } 12000 \
				{ ::crema::devshot::snap 02_live_shot } 200 \
				{ catch { start_idle } } 1500 \
				{ dui page load crema_qa } 2000 \
				{ catch { ::crema::pages::crema_qa::pick taste sour }
				  catch { ::crema::pages::crema_qa::pick body thin }
				  catch { ::crema::pages::crema_qa::pick flow even }
				  catch { ::crema::pages::crema_qa::pick aftertaste short }
				  catch { ::crema::pages::crema_qa::pick enjoyment 3 } } 900 \
				{ ::crema::devshot::snap 03_questionnaire } 200 \
				{ ::crema::devshot::fake_advice; dui page load crema_advice } 2200 \
				{ ::crema::devshot::snap 04_ai_advice } 200 \
				{ dui page load crema_dashboard } 3500 \
				{ ::crema::devshot::snap 05_shot_history } 200 \
				{ catch { ::crema::pages::crema_dashboard::open_row 0 } } 3500 \
				{ ::crema::devshot::snap 06_shot_detail } 200 \
				{ dui page load crema_beans } 2000 \
				{ ::crema::devshot::snap 07_beans } 200 \
				{ dui page load crema_setup } 2000 \
				{ ::crema::devshot::snap 08_setup } 200 \
				{ ::crema::devshot::log "gallery done" } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "llm"} {
			log "direct-provider LLM test (mock endpoint backed by claude -p)"
			set ::crema_settings(ai_provider) anthropic
			set ::crema_settings(ai_base_url) "http://localhost:8877"
			set ::crema_settings(ai_api_key) "test-key"
			set ::crema_settings(ai_model) "claude-opus-4-8"
			set payload [dict create \
				bean [dict create name "Ethiopia Guji" roaster "Test Roasters" roast_date "2026-07-10"] \
				grinder [dict create model "Lagom 01" setting 5.4] \
				dose_g 18.0 final_yield_g 42.5 target_yield_g 40 profile_title "Adaptive" \
				elapsed {0 5 10 15 20 22} pressure {0.5 3 8 9 8.5 8} \
				flow {0 1 2 2.5 3 3.5} weight_flow {0 0 1 2 3 3.5} basket_temp {90 92 93 93 92 92} \
				answers [dict create taste_balance sour body thin flow_look even aftertaste short enjoyment 2]]
			set steps [list \
				{ if {[catch { set ::crema::devshot::adv [::crema::llm::get_advice $::crema::devshot::payload {}] } e]} {
					::crema::devshot::log "LLMFAIL: $e"
				  } else {
					::crema::devshot::log "LLMPASS: [dict get $::crema::devshot::adv screen_summary]"
					::crema::devshot::log "  grind target: [dict get $::crema::devshot::adv actions grind target]"
				  } } 200 \
			]
			set ::crema::devshot::payload $payload
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "advice"} {
			log "starting async-advice capture"
			set steps [list \
				{ set ::crema::advisor::status "waiting"
				  set ::crema::advisor::advice_seen 0
				  ::crema::go_home } 2600 \
				{ ::crema::devshot::snap 00_home_pending } 200 \
				{ dui page load crema_advice } 2000 \
				{ ::crema::devshot::snap 07_advice_waiting } 200 \
				{ ::crema::devshot::fake_advice
				  ::crema::advisor::update_advice_page } 2500 \
				{ ::crema::devshot::snap 08_advice_async } 200 \
				{ catch { ::crema::pages::crema_advice::apply_all } } 1500 \
				{ ::crema::devshot::check_toolbox
				  ::crema::devshot::snap 08b_advice_applied } 200 \
				{ dui page load crema_beans } 1800 \
				{ ::crema::devshot::fake_advice
				  set ::crema::advisor::advice_seen 0
				  ::crema::advisor::deliver_advice } 1200 \
				{ ::crema::devshot::snap 09_beans_noleak } 200 \
				{ ::crema::go_home } 2600 \
				{ ::crema::devshot::snap 10_home_chip } 200 \
				{ set ::crema::advisor::status "waiting"
				  set ::crema::advisor::advice_seen 0
				  ::crema::go_home } 1500 \
				{ dui page load crema_advice } 1500 \
				{ ::crema::go_home } 1500 \
				{ ::crema::devshot::fake_advice
				  ::crema::advisor::deliver_advice } 2600 \
				{ set cs ""
				  catch { set cs [.can itemcget [lindex [.can find withtag home_advice_chip-btn] 0] -state] }
				  set nt ""
				  catch { set nt [.can itemcget [lindex [.can find withtag home_ai_note] 0] -text] }
				  if {$cs eq "normal" && [string match "*Grind*" $nt]} {
					::crema::devshot::log "PEEKPASS: chip=$cs note updated"
				  } else {
					::crema::devshot::log "PEEKFAIL: chip=$cs note='[string range $nt 0 60]'"
				  } } 200 \
				{ set ::crema::advisor::status "idle"
				  array unset ::crema::advisor::advice
				  dui page load crema_advice } 4000 \
				{ set st ""
				  catch { set st [.can itemcget [lindex [.can find withtag adv_summary] 0] -text] }
				  if {$st ne ""} {
					::crema::devshot::log "HYDRPASS: '[string range $st 0 50]'"
				  } else {
					::crema::devshot::log "HYDRFAIL: advice page empty after restart-hydration"
				  } } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "tap"} {
			log "synthetic tap test"
			proc ::crema::devshot::tap {lx ly} {
				set x [expr {int($lx * [winfo width .can] / 2560.0)}]
				set y [expr {int($ly * [winfo height .can] / 1600.0)}]
				event generate .can <Motion> -x $x -y $y
				after 40 [list event generate .can <ButtonPress-1> -x $x -y $y]
				after 120 [list event generate .can <ButtonRelease-1> -x $x -y $y]
			}
			set steps [list \
				{ ::crema::devshot::fake_advice
				  set ::crema::advisor::advice_seen 1
				  ::crema::go_home } 2000 \
				{ ::crema::devshot::tap 1860 1385 } 1500 \
				{ ::crema::devshot::log "TAPTEST details -> [dui page current]" } 300 \
				{ ::crema::go_home } 1500 \
				{ ::crema::devshot::tap 1690 320 } 1500 \
				{ ::crema::devshot::log "TAPTEST dial -> [dui page current]" } 300 \
				{ ::crema::go_home } 1500 \
				{ dui page load crema_dashboard } 3500 \
				{ ::crema::devshot::tap 600 380 } 2500 \
				{ ::crema::devshot::log "TAPTEST row -> [dui page current]" } 300 \
				{ ::crema::go_home } 1500 \
				{ ::crema::devshot::tap 360 1530 } 1500 \
				{ ::crema::devshot::log "TAPTEST navlabel -> [dui page current]" } 300 \
				{ ::crema::devshot::log "tap test done" } 200 \
			]
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "sit"} {
			log "soak: chip -> advice page, watching for spontaneous navigation"
			set steps [list \
				{ ::crema::devshot::fake_advice
				  set ::crema::advisor::advice_seen 0
				  ::crema::go_home } 3000 \
				{ dui page load crema_advice } 2000 \
			]
			for {set i 0} {$i < 60} {incr i} {
				lappend steps { catch { ::crema::devshot::log "soak page=[dui page current]" } } 2000
			}
			lappend steps { ::crema::devshot::log "soak done" } 200
			step
			return
		}
		if {$::env(CREMA_DEVSHOT) eq "live"} {
			log "starting live-shot capture"
			set steps [list \
				{ ::crema::go_home } 1500 \
				{ set ::settings(bluetooth_address) ""
				  catch { start_espresso } } 12000 \
				{ ::crema::devshot::snap 06_live_home } 200 \
				{ catch { start_idle } } 1000 \
			]
			step
			return
		}
		catch { file delete {*}[glob -nocomplain $outdir/*.png] }
		log "starting page tour"
		set steps [list \
			{ ::crema::go_home } 1500 \
			{ ::crema::devshot::snap 01_home } 200 \
			{ dui page load crema_beans } 1500 \
			{ ::crema::devshot::snap 02_beans } 200 \
			{ catch { ::crema::pages::crema_beans::save_and_confirm }
			  set fn [::crema::settings_filename]
			  if {[file exists $fn]} {
				::crema::devshot::log "SAVEPASS: persisted to $fn"
			  } else {
				::crema::devshot::log "SAVEFAIL: no file at $fn"
			  } } 400 \
			{ ::crema::go_home } 1200 \
			{ dui page load crema_qa } 1500 \
			{ catch { ::crema::pages::crema_qa::pick taste sour }
			  catch { ::crema::pages::crema_qa::pick enjoyment 3 } } 600 \
			{ ::crema::devshot::snap 03_qa } 200 \
			{ ::crema::go_home } 1200 \
			{ ::crema::devshot::fake_advice
			  dui page load crema_advice } 1500 \
			{ ::crema::devshot::snap 04_advice } 200 \
			{ ::crema::go_home } 1200 \
			{ dui page load crema_dashboard } 4000 \
			{ ::crema::devshot::snap 05_dashboard } 200 \
			{ catch { ::crema::pages::crema_dashboard::open_row 0 } } 4000 \
			{ ::crema::devshot::snap 06_detail } 200 \
		]
		step
	}
}

after 15000 ::crema::devshot::run
