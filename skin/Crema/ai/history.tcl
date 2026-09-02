# Crema history data source — one interface the dashboard, home strip, and
# shot-detail page use, dispatching to either the local store (standalone) or
# the Mac server (server mode). Callbacks are used everywhere so the server
# path can stay async; the store path answers on the next event loop tick.
#
# Normalized shot shape (what callers get):
#   {id <n> created_at <iso> payload <dict> advice <dict|null>}
# where payload carries bean{name}, grinder{setting}, dose_g, final_yield_g,
# duration_s, answers{}, and (for detail) the curve lists.

namespace eval ::crema::history {

	proc standalone {} { return [expr {$::crema_settings(ai_mode) eq "standalone"}] }

	# recent {limit cb {bean ""}}: cb called as {cb <list-of-shots>} (empty on
	# failure). When bean is non-empty, only shots for that bean are returned so
	# the home strip / dashboard stay scoped to the loaded bean (no cross-bean bleed).
	proc recent {limit cb {bean ""}} {
		if {[standalone]} {
			set out {}
			set recs {}
			catch { set recs [::crema::store::recent $limit $bean] }
			# per-record guard: a single partial/corrupt .shot file must NOT blank
			# the whole history (one uncaught dict get used to abort the entire loop)
			foreach rec $recs {
				catch { lappend out [_wrap $rec] }
			}
			after 0 [list {*}$cb $out]
			return
		}
		# server
		set url "$::crema_settings(server_url)/shots?limit=$limit"
		# properly URL-encode the bean name (names can contain & # + spaces etc.)
		if {$bean ne ""} { catch { append url "&[::http::formatQuery bean $bean]" } }
		if {[catch {
			::http::geturl $url -timeout 8000 \
				-command [list ::crema::history::_recent_http $cb]
		}]} { after 0 [list {*}$cb {}] }
	}

	proc _recent_http {cb tok} {
		set out {}
		catch {
			set body [encoding convertfrom utf-8 [::http::data $tok]]
			::http::cleanup $tok
			set out [dict get [::json::json2dict $body] shots]
		}
		catch { ::http::cleanup $tok }
		after 0 [list {*}$cb $out]
	}

	# get {id cb}: cb called as {cb <shot|empty>}
	proc get {id cb} {
		if {[standalone]} {
			set rec [::crema::store::get $id]
			if {[dict size $rec]} {
				after 0 [list {*}$cb [_wrap $rec]]
			} else {
				after 0 [list {*}$cb {}]
			}
			return
		}
		if {[catch {
			::http::geturl "$::crema_settings(server_url)/shot/$id" -timeout 8000 \
				-command [list ::crema::history::_get_http $cb]
		}]} { after 0 [list {*}$cb {}] }
	}

	proc _get_http {cb tok} {
		set out {}
		catch {
			set body [encoding convertfrom utf-8 [::http::data $tok]]
			::http::cleanup $tok
			set out [dict get [::json::json2dict $body] shot]
		}
		catch { ::http::cleanup $tok }
		after 0 [list {*}$cb $out]
	}

	# rate {id answers cb}: score a shot that is already in history.
	# cb called as {cb 1|0}.
	proc rate {id answers cb} {
		if {[standalone]} {
			set ok 0
			catch { set ok [::crema::store::rate $id $answers] }
			after 0 [list {*}$cb $ok]
			return
		}
		# answers is a flat dict of scores/labels; build the object by hand with
		# the advisor's own escaper rather than pulling in a serializer
		set parts {}
		foreach {k v} $answers {
			if {$v eq ""} { continue }
			if {[string is integer -strict $v]} {
				lappend parts "[::crema::llm::jstr $k]:$v"
			} else {
				lappend parts "[::crema::llm::jstr $k]:[::crema::llm::jstr $v]"
			}
		}
		if {![llength $parts]} { after 0 [list {*}$cb 0] ; return }
		set body "{\"answers\":{[join $parts ,]}}"
		if {[catch {
			::http::geturl "$::crema_settings(server_url)/shot/$id/rating" \
				-timeout 8000 -type "application/json" \
				-query [encoding convertto utf-8 $body] \
				-command [list ::crema::history::_rate_http $cb]
		}]} { after 0 [list {*}$cb 0] }
	}

	proc _rate_http {cb tok} {
		set ok 0
		catch {
			set code [::http::ncode $tok]
			if {$code >= 200 && $code < 300} { set ok 1 }
		}
		catch { ::http::cleanup $tok }
		after 0 [list {*}$cb $ok]
	}

	# store record -> normalized shot shape (record IS the payload)
	proc _wrap {rec} {
		# require the two identifying fields; a partial write missing them is
		# skipped by the caller's per-record catch rather than blanking history
		set id [dict get $rec id]
		set created [dict get $rec created_at]
		set adv "null"
		catch { set adv [dict get $rec advice] }
		return [dict create id $id created_at $created payload $rec advice $adv]
	}
}
