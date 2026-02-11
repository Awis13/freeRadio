#!/usr/bin/env liquidsoap

settings.log.level := 3
settings.log.stdout := true
settings.frame.audio.samplerate := 44100
settings.frame.audio.channels := 2

music = playlist(mode = "randomize", reload = 1, reload_mode = "rounds", "/music")

def write_track(m) =
  file.write(data=m["filename"], "/shared/current_audio.txt")
end
music = source.on_metadata(music, write_track)

safety = blank(duration = 1.0)
src = fallback(track_sensitive = false, [music, safety])
src = mksafe(src)

# ============================================
# PRO DJ CROSSFADE
# Long smooth mix like club DJ
# ============================================

# Custom crossfade - smooth blend with log curves
def pro_mix(old, new) =
  # Log the transition
  log("MIX: transition starting")
  
  # Smooth DJ blend:
  # - Old track: 8s fade out (logarithmic)
  # - New track: 6s fade in (logarithmic)
  
  old_faded = fade.out(
    duration = 8.0,
    type = "log",
    old.source
  )
  
  new_faded = fade.in(
    duration = 6.0,
    type = "log",
    new.source
  )
  
  # Mix both
  add(normalize = false, [old_faded, new_faded])
end

# 10 second crossfade window
radio = cross(duration = 10.0, pro_mix, src)
radio = mksafe(radio)

# Master processing
processed = normalize(target = -14.0, gain_max = 3.0, gain_min = -3.0, radio)
processed = compress(threshold = -18.0, ratio = 3.0, attack = 5.0, release = 150.0, processed)
processed = mksafe(processed)
processed = limit(threshold = -1.0, attack = 0.5, release = 80.0, processed)

output.icecast(
  %mp3(bitrate = 320, samplerate = 44100, stereo = true, id3v2 = true),
  host = "icecast", port = 8000, password = "hackme", mount = "/live",
  name = "SYSTEM 23", genre = "Hard Techno", description = "SYSTEM 23 AutoDJ",
  processed
)
