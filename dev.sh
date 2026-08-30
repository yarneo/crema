#!/bin/bash
# Launch the desktop de1app simulator with the Crema skin in a screen-fitting
# window (1280x800 = the tablet's aspect). Pass CREMA_SELFTEST=1 to auto-run
# the full shot -> Q&A -> advice -> dashboard verification.
cd "$(dirname "$0")/../de1app/de1plus" || exit 1
# One rule learned the hard way: pass ONLY the window size. The render root
# then inherits it, so render, window, and taps share one coordinate space.
# Splitting -sdlrootwidth from -sdlwidth breaks on retina/Spaces resizes.
# settings.tdb screen_size_width/height must match this size (app caches it).
exec ../misc/desktop_app/osx_arm64/undroidwish-arm64 de1plus.tcl \
	-sdlwidth 2400 -sdlheight 1500 -sdlnoborder \
	-name Crema
