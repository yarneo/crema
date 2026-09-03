# Source the file with missing de1app commands stubbed out, but REFUSE names
# that cannot be a real command - a stray "}" from a bad edit lands here.
# `info complete` cannot see this class of bug; it cost a broken skin once.
proc unknown {args} {
  set cmd [lindex $args 0]
  if {![regexp {^[A-Za-z_:][A-Za-z0-9_:.<>-]*$} $cmd]} {
    return -code error "stray/unparseable command: [list $cmd]"
  }
  return ""
}
# de1app ships these; tclsh here does not
proc package {args} { return "" }
# Files define procs into namespaces their siblings create, so checking one
# file alone would fail on "unknown namespace" rather than on a real defect.
foreach ns {::crema ::crema::llm ::crema::store ::crema::history ::crema::advisor
            ::crema::pages ::crema::selftest ::crema::devshot} {
  namespace eval $ns {}
}
set rc 0
foreach f $argv {
  if {[catch { source $f } e]} { puts "$f: FAIL: $e" ; set rc 1 } else { puts "$f: ok" }
}
exit $rc

# Usage: tclsh tools/tclcheck.tcl skin/Crema/ai/*.tcl
#
# `info complete` only proves the braces BALANCE. A duplicated "}" left by a
# bad edit balances fine and still breaks the skin at load time with
# 'invalid command name "}"' - at which point de1app resets ::settings(skin)
# to Insight and the tablet comes up on the stock skin. This sources each file
# with missing de1app commands stubbed, and refuses any command name that
# cannot be an identifier, so that class of bug is caught before it ships.
