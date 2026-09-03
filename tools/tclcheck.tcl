# Static checks for the Crema skin's Tcl, run before pushing to the tablet.
#
#   tclsh tools/tclcheck.tcl skin/Crema/ai/*.tcl
#
# Catches two classes of bug that cost real time, neither of which `info
# complete` can see:
#
#  1. A stray "}" from a bad edit. Braces still BALANCE, so info complete says
#     OK, and the skin then dies at load with 'invalid command name "}"' - at
#     which point de1app resets ::settings(skin) to Insight and the tablet
#     comes up on the stock skin.
#
#  2. A broken line continuation, where an edit drops the first line of a
#     multi-line call and leaves its options dangling. Sourcing a file only
#     DEFINES its procs, it never runs their bodies, so this is invisible to
#     any check that just sources the file.

# de1app commands are stubbed, but a name that cannot be an identifier - which
# is where a stray brace lands - is an error.
proc unknown {args} {
  set cmd [lindex $args 0]
  if {![regexp {^[A-Za-z_:][A-Za-z0-9_:.<>-]*$} $cmd]} {
    return -code error "stray/unparseable command: [list $cmd]"
  }
  return ""
}
proc package {args} { return "" }

# Files define procs into namespaces their siblings create.
foreach ns {::crema ::crema::llm ::crema::store ::crema::history ::crema::advisor
            ::crema::pages ::crema::selftest ::crema::devshot} {
  namespace eval $ns {}
}

# A statement may only begin with "-" if the previous line ended in a
# backslash. Anything else is a dangling options line.
proc scan_dangling {f} {
  set fh [open $f r]
  set n 0 ; set bad 0 ; set prev ""
  while {[gets $fh line] >= 0} {
    incr n
    set t [string trim $line]
    set p [string trim $prev]
    if {[string match {-[a-zA-Z]*} $t] && [string index $p end] ne "\\"} {
      puts "  $f:$n: dangling option line: [string range $t 0 60]"
      incr bad
    }
    set prev $line
  }
  close $fh
  return $bad
}

set rc 0
foreach f $argv {
  set d [scan_dangling $f]
  if {[catch { source $f } e]} {
    puts "$f: FAIL: $e" ; set rc 1
  } elseif {$d > 0} {
    puts "$f: FAIL: $d dangling option line(s)" ; set rc 1
  } else {
    puts "$f: ok"
  }
}
exit $rc
