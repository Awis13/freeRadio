#!/usr/bin/env liquidsoap

# SYSTEM 23 — Hard Techno AutoDJ with Analysis-Based Mixing

settings.init.allow_root := true
settings.log.level := 3
settings.log.stdout := true
settings.frame.audio.samplerate := 44100
settings.frame.audio.channels := 2

# ---- SOURCE ----

music = playlist(
  mode = "randomize",
  reload = 1,
  reload_mode = "rounds",
  "/music"
)

safety = blank(duration = 1.0)
my_source = fallback(track_sensitive = false, [music, safety])
my_source = mksafe(my_source)

current_track = ref("")
next_track = ref("")
current_title = ref("")

def on_track_handler(m) =
  filename = m["filename"] ?? ""
  title = m["title"] ?? ""
  current_track := next_track()
  next_track := filename
  current_title := title
  file.write(data=filename, "/shared/current_audio.txt")
end

my_source = source.on_metadata(my_source, on_track_handler)

settings.harbor.bind_addrs := ["0.0.0.0"]

harbor.http.register(port=7000, method="GET", "/metadata",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"title": "#{current_title}", "filename": "#{current_track}"}')
  end
)

# ---- HELPERS ----

# Get basename from path
def get_basename(path) =
  string.replace(pattern = "^.*/", fun(_) -> "", path)
end

# ---- ANALYSIS DATA ----

# Get BPM from analysis map
def get_analysis_bpm(filename) =
  result = ref(0.0)
  
  if filename != "" and file.exists("/music/.analysis_map") then
    target_base = get_basename(filename)
    lines = file.lines("/music/.analysis_map")
    
    list.iter(fun(line) -> begin
      parts = string.split(separator = "\\|", line)
      if list.length(parts) >= 2 then
        path_opt = list.nth(parts, 0)
        bpm_opt = list.nth(parts, 1)
        
        path_str = path_opt ?? ""
        bpm_str = bpm_opt ?? ""
        
        if path_str != "" then
          line_base = get_basename(path_str)
          if line_base == target_base and result() == 0.0 then
            result := string.to_float(default=0.0, bpm_str)
          end
        end
      end
    end, lines)
  end
  
  result()
end

# Fallback BPM from old map
def get_bpm_fallback(filename) =
  result = ref(0.0)
  if filename != "" and file.exists("/music/.bpm_map") then
    target_base = get_basename(filename)
    lines = file.lines("/music/.bpm_map")
    list.iter(fun(line) -> begin
      parts = string.split(separator = "\\|", line)
      if list.length(parts) >= 2 then
        path_opt = list.nth(parts, 0)
        bpm_opt = list.nth(parts, 1)
        
        path_str = path_opt ?? ""
        bpm_str = bpm_opt ?? ""
        
        if path_str != "" then
          line_base = get_basename(path_str)
          if line_base == target_base then
            result := string.to_float(default=0.0, bpm_str)
          end
        end
      end
    end, lines)
  end
  result()
end

def bars(bpm, n) =
  if bpm > 0.0 then 240.0 / bpm * n
  else 240.0 / 150.0 * n end
end

# ---- TRANSITION ----

def smart_mix(a, b) =
  old_name_str = current_track()
  new_name_str = next_track()
  
  old_bpm = get_analysis_bpm(old_name_str)
  new_bpm = get_analysis_bpm(new_name_str)
  
  if old_bpm == 0.0 then
    old_bpm = get_bpm_fallback(old_name_str)
  end
  if new_bpm == 0.0 then
    new_bpm = get_bpm_fallback(new_name_str)
  end
  
  bpm = if old_bpm > 0.0 and new_bpm > 0.0 then
    (old_bpm + new_bpm) / 2.0
  elsif old_bpm > 0.0 then
    old_bpm
  elsif new_bpm > 0.0 then
    new_bpm
  else
    150.0
  end
  
  has_analysis = old_bpm > 0.0 and new_bpm > 0.0
  
  log("")
  log("MIX: #{old_name_str} -> #{new_name_str}")
  log("BPM: #{old_bpm} -> #{new_bpm} (using #{bpm})")
  
  beat_duration = 60.0 / bpm
  bar_duration = beat_duration * 4.0
  
  if has_analysis then
    mix_bars = 8.0
    mix_duration = mix_bars * bar_duration
    log("SMART MIX: #{mix_bars} bars (#{mix_duration}s) - ON BEAT!")
    
    old_fade = 2.0 * bar_duration
    old_out = fade.out(duration = old_fade, type = "sin", a.source)
    
    new_fade = 6.0 * bar_duration
    new_in = fade.in(duration = new_fade, type = "log", b.source)
    
    mixed = add(normalize = false, [old_out, new_in])
    compress(threshold = -14.0, ratio = 3.0, attack = 5.0, release = 100.0, mixed)
    
  elsif bpm > 0.0 then
    mix_bars = 8.0
    duration = mix_bars * bar_duration
    log("BPM MIX: #{mix_bars} bars (#{duration}s)")
    
    old_out = fade.out(duration = duration, type = "sin", a.source)
    new_in = fade.in(duration = duration, type = "sin", b.source)
    
    mixed = add(normalize = false, [old_out, new_in])
    compress(threshold = -12.0, ratio = 4.0, attack = 5.0, release = 100.0, mixed)
    
  else
    log("SIMPLE MIX: 8s")
    old_out = fade.out(duration = 8.0, type = "sin", a.source)
    new_in = fade.in(duration = 8.0, type = "sin", b.source)
    add(normalize = false, [old_out, new_in])
  end
end

radio = cross(duration = 20.0, smart_mix, my_source)
radio = mksafe(radio)

# ---- MASTER ----

processed = normalize(target = -14.0, gain_max = 3.0, gain_min = -3.0, radio)
processed = compress(threshold = -16.0, ratio = 2.5, attack = 3.0, release = 100.0, processed)
processed = mksafe(processed)
processed = limit(threshold = -1.0, attack = 0.5, release = 50.0, processed)

# ---- OUTPUT ----

output.icecast(
  %mp3(bitrate = 320, samplerate = 44100, stereo = true, id3v2 = true),
  host = "icecast", port = 8000, password = "hackme", mount = "/live",
  name = "SYSTEM 23", genre = "Hard Techno",
  description = "SYSTEM 23 — Hard Techno AutoDJ",
  processed
)
