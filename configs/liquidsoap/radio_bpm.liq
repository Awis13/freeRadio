#!/usr/bin/env liquidsoap

# STUDIO 23 — AutoDJ with Analysis-Based Mixing

settings.init.allow_root := true
settings.log.level := 3
settings.log.stdout := true
settings.frame.audio.samplerate := 44100
settings.frame.audio.channels := 2

# ---- SOURCE ----

music = playlist(
  id = "music",
  mode = "randomize",
  reload = 1,
  reload_mode = "rounds",
  "/music/processed"
)

queue = request.queue(id="queue")
voice_queue = request.queue(id="voice_queue")

safety = blank(duration = 1.0)
my_source = fallback(track_sensitive = true, [queue, music, safety])
my_source = mksafe(my_source)

current_track = ref("")
next_track = ref("")
current_title = ref("")
queue_list = ref([])
mix_mode = ref("smart")
prev_track_start = ref(0.0)
curr_track_start = ref(0.0)
dj_playing = ref(false)

def on_track_handler(m) =
  filename = m["filename"] ?? ""
  title = m["title"] ?? ""
  # Внутренние данные для cross/beat-align обновляем всегда
  current_track := next_track()
  next_track := filename
  prev_track_start := curr_track_start()
  curr_track_start := time()
  # Title и файл для UI — только когда играем
  if dj_playing() then
    current_title := title
    file.write(data=filename, "/shared/current_audio.txt")
  end
  items = queue_list()
  if list.length(items) > 0 then
    queue_list := list.tl(items)
  end
end

my_source = source.on_metadata(my_source, on_track_handler)

settings.harbor.bind_addrs := ["0.0.0.0"]

harbor.http.register(port=7000, method="GET", "/metadata",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    if dj_playing() then
      resp.data('{"title": "#{json_str(current_title())}", "filename": "#{json_str(current_track())}"}')
    else
      resp.data('{"title": "", "filename": ""}')
    end
  end
)

# ---- QUEUE ENDPOINTS ----

harbor.http.register(port=7000, method="POST", "/queue/push",
  fun(req, resp) -> begin
    body = req.body()
    path = string.trim(body)
    if path != "" then
      queue.push(request.create(path))
      queue_list := list.append(queue_list(), [path])
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.data('{"ok": true, "path": "#{json_str(path)}"}')
    else
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.status_code(400)
      resp.data('{"error": "empty path"}')
    end
  end
)

harbor.http.register(port=7000, method="POST", "/skip",
  fun(_, resp) -> begin
    source.skip(my_source)
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true}')
  end
)

harbor.http.register(port=7000, method="GET", "/queue",
  fun(_, resp) -> begin
    items = queue_list()
    json_items = list.map(fun(p) -> '"#{json_str(p)}"', items)
    json_joined = string.concat(separator=",", json_items)
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data("[#{json_joined}]")
  end
)

harbor.http.register(port=7000, method="POST", "/queue/clear",
  fun(_, resp) -> begin
    queue_list := []
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true}')
  end
)

harbor.http.register(port=7000, method="GET", "/queue/length",
  fun(_, resp) -> begin
    items = queue_list()
    len = list.length(items)
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"length": #{len}}')
  end
)

# ---- HELPERS ----

# Get basename from path
def get_basename(path) =
  string.replace(pattern = "^.*/", fun(_) -> "", path)
end

# Strip file extension (track.mp3 → track)
def strip_ext(name) =
  string.replace(pattern = "\\.[^.]*$", fun(_) -> "", name)
end
# Produce JSON-safe escaped string (without outer quotes).
# json.stringify wraps: test -> "test", he"llo -> "he\"llo"
# string.sub strips the outer quotes.
def json_str(s) =
  j = json.stringify(s)
  if string.length(j) >= 2 then
    string.sub(j, start=1, length=string.length(j) - 2)
  else
    s
  end
end


# ---- ANALYSIS DATA ----
# Формат .analysis_map:
# filepath|bpm|duration|intro_end|outro_start|mix_in|mix_out|first_beat
# Индексы: 0     |1  |2       |3        |4          |5     |6      |7

# Универсальный читатель полей из .analysis_map
def get_analysis_field(filename, field_index) =
  result = ref(0.0)

  if filename != "" and file.exists("/music/.analysis_map") then
    target_base = strip_ext(get_basename(filename))
    lines = file.lines("/music/.analysis_map")

    list.iter(fun(line) -> begin
      parts = string.split(separator = "\\|", line)
      if list.length(parts) > field_index then
        path_opt = list.nth(parts, 0)
        val_opt = list.nth(parts, field_index)

        path_str = path_opt ?? ""
        val_str = val_opt ?? ""

        if path_str != "" then
          line_base = strip_ext(get_basename(path_str))
          if line_base == target_base and result() == 0.0 then
            result := string.to_float(default=0.0, val_str)
          end
        end
      end
    end, lines)
  end

  result()
end

# Читатели конкретных полей
def get_analysis_bpm(filename) = get_analysis_field(filename, 1) end
def get_track_duration(filename) = get_analysis_field(filename, 2) end
def get_intro_end(filename) = get_analysis_field(filename, 3) end
def get_outro_start(filename) = get_analysis_field(filename, 4) end
def get_mix_in(filename) = get_analysis_field(filename, 5) end
def get_mix_out(filename) = get_analysis_field(filename, 6) end
def get_first_beat(filename) = get_analysis_field(filename, 7) end

# Fallback BPM from old map
def get_bpm_fallback(filename) =
  result = ref(0.0)
  if filename != "" and file.exists("/music/.bpm_map") then
    target_base = strip_ext(get_basename(filename))
    lines = file.lines("/music/.bpm_map")
    list.iter(fun(line) -> begin
      parts = string.split(separator = "\\|", line)
      if list.length(parts) >= 2 then
        path_opt = list.nth(parts, 0)
        bpm_opt = list.nth(parts, 1)

        path_str = path_opt ?? ""
        bpm_str = bpm_opt ?? ""

        if path_str != "" then
          line_base = strip_ext(get_basename(path_str))
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
  else 240.0 / 120.0 * n end
end

# Compute delay to align incoming track's beats with outgoing track's beat grid
def compute_beat_delay(old_bpm, old_first_beat, new_first_beat) =
  if old_bpm <= 0.0 or prev_track_start() <= 0.0 then
    log("BEAT ALIGN: skipped (no data)")
    0.0
  else
    elapsed = time() - prev_track_start()
    beat_period = 60.0 / old_bpm

    # Phase of outgoing track within beat cycle
    raw_phase = elapsed - old_first_beat
    phase = raw_phase - floor(raw_phase / beat_period) * beat_period

    # Time until next beat of outgoing track
    time_to_next = beat_period - phase

    # Delay for incoming track so its first beat lands on outgoing grid
    raw_delay = time_to_next - new_first_beat
    delay = raw_delay - floor(raw_delay / beat_period) * beat_period

    # If delay is nearly a full beat period, treat as zero (already aligned)
    if delay > beat_period - 0.01 then
      delay = 0.0
    end

    log("BEAT ALIGN: elapsed=#{elapsed}s, beat_period=#{beat_period}s, phase=#{phase}s, delay=#{delay}s")
    delay
  end
end

# ---- TRANSITION ----

# Максимальный cross buffer (секунды). Определяет максимально доступный overlap.
cross_buffer = 5.0

# --- Mode: Smart (BPM-aware, 2-3 bars at techno BPMs, beat-aligned, sin curves, compression) ---
def do_smart(a_src, b_src, old_bpm, new_bpm) =
  bpm = if old_bpm > 0.0 and new_bpm > 0.0 then
    (old_bpm + new_bpm) / 2.0
  elsif old_bpm > 0.0 then
    old_bpm
  elsif new_bpm > 0.0 then
    new_bpm
  else
    120.0
  end

  has_analysis = old_bpm > 0.0 and new_bpm > 0.0
  beat_duration = 60.0 / bpm
  bar_duration = beat_duration * 4.0

  max_mix = cross_buffer - 0.5
  mix_bars = min(8.0, floor(max_mix / bar_duration))
  mix_bars = max(2.0, mix_bars)
  mix_dur = mix_bars * bar_duration
  # Clamp mix duration to buffer size (safety for low BPMs where 2-bar > buffer)
  mix_dur = min(max_mix, mix_dur)

  if has_analysis then
    log("SMART: #{mix_bars} bars (#{mix_dur}s) at #{bpm} BPM")
  elsif bpm > 0.0 then
    log("SMART (partial): #{mix_bars} bars (#{mix_dur}s) at #{bpm} BPM")
  else
    log("SMART (fallback): #{mix_bars} bars (#{mix_dur}s) at #{bpm} BPM")
  end

  # Equal-power crossfade: same duration for fade-in and fade-out
  # sin curves -> at midpoint both at 0.707 -> constant RMS power
  old_out = fade.out(duration = mix_dur, type = "sin", a_src)
  new_in = fade.in(duration = mix_dur, type = "sin", b_src)
  mixed = add(normalize = false, [old_out, new_in])
  # Gentle limiter to catch peak overlap (+3dB max at midpoint)
  compress(threshold = -12.0, ratio = 2.5, attack = 10.0, release = 250.0, mixed)
end

# --- Mode: Cut (hard cut, no overlap) ---
def do_cut(a, b) =
  log("CUT: hard transition")
  sequence([b.source])
end

# --- Mode: Crossfade (simple linear fade, no BPM awareness) ---
def do_crossfade(a, b) =
  fade_dur = cross_buffer - 0.5
  log("CROSSFADE: #{fade_dur}s linear")
  old_out = fade.out(duration = fade_dur, type = "lin", a.source)
  new_in = fade.in(duration = fade_dur, type = "lin", b.source)
  add(normalize = false, [old_out, new_in])
end

# --- Dispatcher ---
def smart_mix(a, b) =
  old_name_str = current_track()
  new_name_str = next_track()

  mode = mix_mode()
  log("")
  log("MIX: #{old_name_str} -> #{new_name_str} [mode=#{mode}]")

  if mode == "cut" then
    do_cut(a, b)
  elsif mode == "crossfade" then
    do_crossfade(a, b)
  else
    # --- Читаем ВСЕ данные анализа для обоих треков ---
    old_bpm = get_analysis_bpm(old_name_str)
    new_bpm = get_analysis_bpm(new_name_str)
    if old_bpm == 0.0 then
      old_bpm = get_bpm_fallback(old_name_str)
    end
    if new_bpm == 0.0 then
      new_bpm = get_bpm_fallback(new_name_str)
    end

    old_first_beat = get_first_beat(old_name_str)
    new_first_beat = get_first_beat(new_name_str)

    # Beat-phase alignment: delay incoming track to sync kicks
    delay = compute_beat_delay(old_bpm, old_first_beat, new_first_beat)
    log("BPM: #{old_bpm} -> #{new_bpm}, first_beat: #{old_first_beat} -> #{new_first_beat}, beat-align delay=#{delay}s")

    # Apply delay to incoming source before passing to mix function
    b_src = if delay > 0.01 then
      sequence([blank(duration=delay), b.source])
    else
      b.source
    end

    do_smart(a.source, b_src, old_bpm, new_bpm)
  end

end

# 5s cross buffer — 2-3 bar crossfade at typical techno BPMs
radio = cross(duration = cross_buffer, smart_mix, my_source)
radio = mksafe(radio)

# ---- MASTER ----
# DSP (normalize/compress/limit) removed — applied at transcode time via loudnorm

processed = radio

# ---- CHANNEL STRIP (серверная обработка звука) ----
# Gate → EQ(3-band) → Compressor → Limiter → Output Gain
# Все параметры — ref() getter functions, меняются мгновенно через HTTP без перезапуска.

strip_bypass = ref(true)

# Gate
strip_gate_threshold = ref(-30.0)
strip_gate_attack = ref(0.01)
strip_gate_release = ref(0.5)
strip_gate_hold = ref(0.5)
strip_gate_range = ref(-30.0)

# EQ: lowshelf + peak + highshelf
strip_eq_low_freq = ref(200.0)
strip_eq_low_slope = ref(0.0)
strip_eq_mid_freq = ref(1000.0)
strip_eq_mid_gain = ref(0.0)
strip_eq_mid_q = ref(1.0)
strip_eq_high_freq = ref(6000.0)
strip_eq_high_slope = ref(0.0)

# Compressor
strip_comp_threshold = ref(-10.0)
strip_comp_ratio = ref(2.0)
strip_comp_attack = ref(50.0)
strip_comp_release = ref(400.0)
strip_comp_knee = ref(1.0)
strip_comp_makeup = ref(0.0)

# Limiter
strip_lim_threshold = ref(-2.0)
strip_lim_attack = ref(50.0)
strip_lim_release = ref(200.0)

# Output
strip_output_gain = ref(1.0)

# DSP цепочка
# strip_gated = gate(
#   threshold={strip_gate_threshold()},
#   attack={strip_gate_attack()},
#   release={strip_gate_release()},
#   hold={strip_gate_hold()},
#   range={strip_gate_range()},
#   processed)

# strip_eq1 = filter.iir.eq.lowshelf(
#   frequency={strip_eq_low_freq()},
#   slope={strip_eq_low_slope()},
#   strip_gated)

# strip_eq2 = filter.iir.eq.peak(
#   frequency={strip_eq_mid_freq()},
#   gain={strip_eq_mid_gain()},
#   q={strip_eq_mid_q()},
#   strip_eq1)

# strip_eq3 = filter.iir.eq.highshelf(
#   frequency={strip_eq_high_freq()},
#   slope={strip_eq_high_slope()},
#   strip_eq2)

# strip_compressed = compress(
#   threshold={strip_comp_threshold()},
#   ratio={strip_comp_ratio()},
#   attack={strip_comp_attack()},
#   release={strip_comp_release()},
#   knee={strip_comp_knee()},
#   gain={strip_comp_makeup()},
#   strip_eq3)

# strip_limited = limit(
#   threshold={strip_lim_threshold()},
#   attack={strip_lim_attack()},
#   release={strip_lim_release()},
#   strip_compressed)

# strip_gained = amplify(override=null(), {strip_output_gain()}, strip_limited)

# Channel strip BYPASSED — Phase 2/3 (gate/eq/comp/limit убраны из source graph)
# strip_out = switch(track_sensitive=false, [
#   ({not strip_bypass()}, strip_gained),
#   ({true}, processed)
# ])
strip_out = processed

# ---- CHANNEL STRIP PERSISTENCE ----
# Загружаем настройки из JSON при старте
def strip_load_config() =
  path = "/shared/channel_strip.json"
  if file.exists(path) then
    data = file.contents(path)
    log("STRIP: loading config from #{path}")

    # Парсим каждый параметр через regex
    let extract = fun(key, default_val) -> begin
      pat = '"#{key}"\\s*:\\s*(-?[0-9.]+)'
      m = string.extract(pattern=pat, data)
      v = m[1] ?? ""
      if v != "" then string.to_float(default=default_val, v)
      else default_val end
    end

    # Bypass
    bp_match = string.extract(pattern='"bypass"\\s*:\\s*(true|false)', data)
    bp_str = bp_match[1] ?? ""
    if bp_str == "false" then strip_bypass := false
    elsif bp_str == "true" then strip_bypass := true end

    strip_gate_threshold := extract("gate_threshold", -30.0)
    strip_gate_attack := extract("gate_attack", 10.0)
    strip_gate_release := extract("gate_release", 2000.0)
    strip_gate_hold := extract("gate_hold", 1000.0)
    strip_gate_range := extract("gate_range", -30.0)

    strip_eq_low_freq := extract("eq_low_freq", 200.0)
    strip_eq_low_slope := extract("eq_low_slope", 0.0)
    strip_eq_mid_freq := extract("eq_mid_freq", 1000.0)
    strip_eq_mid_gain := extract("eq_mid_gain", 0.0)
    strip_eq_mid_q := extract("eq_mid_q", 1.0)
    strip_eq_high_freq := extract("eq_high_freq", 6000.0)
    strip_eq_high_slope := extract("eq_high_slope", 0.0)

    strip_comp_threshold := extract("comp_threshold", -10.0)
    strip_comp_ratio := extract("comp_ratio", 2.0)
    strip_comp_attack := extract("comp_attack", 50.0)
    strip_comp_release := extract("comp_release", 400.0)
    strip_comp_knee := extract("comp_knee", 1.0)
    strip_comp_makeup := extract("comp_makeup", 0.0)

    strip_lim_threshold := extract("lim_threshold", -2.0)
    strip_lim_attack := extract("lim_attack", 50.0)
    strip_lim_release := extract("lim_release", 200.0)

    strip_output_gain := extract("output_gain", 1.0)

    log("STRIP: config loaded (bypass=#{strip_bypass()})")
  else
    log("STRIP: no config file, using defaults (bypass=true)")
  end
end

strip_load_config()

# ---- CHANNEL STRIP HTTP ENDPOINTS ----

# GET /strip/config — текущие параметры
harbor.http.register(port=7000, method="GET", "/strip/config",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{
  "bypass": #{strip_bypass()},
  "gate_threshold": #{strip_gate_threshold()},
  "gate_attack": #{strip_gate_attack()},
  "gate_release": #{strip_gate_release()},
  "gate_hold": #{strip_gate_hold()},
  "gate_range": #{strip_gate_range()},
  "eq_low_freq": #{strip_eq_low_freq()},
  "eq_low_slope": #{strip_eq_low_slope()},
  "eq_mid_freq": #{strip_eq_mid_freq()},
  "eq_mid_gain": #{strip_eq_mid_gain()},
  "eq_mid_q": #{strip_eq_mid_q()},
  "eq_high_freq": #{strip_eq_high_freq()},
  "eq_high_slope": #{strip_eq_high_slope()},
  "comp_threshold": #{strip_comp_threshold()},
  "comp_ratio": #{strip_comp_ratio()},
  "comp_attack": #{strip_comp_attack()},
  "comp_release": #{strip_comp_release()},
  "comp_knee": #{strip_comp_knee()},
  "comp_makeup": #{strip_comp_makeup()},
  "lim_threshold": #{strip_lim_threshold()},
  "lim_attack": #{strip_lim_attack()},
  "lim_release": #{strip_lim_release()},
  "output_gain": #{strip_output_gain()}
}')
  end
)

# POST /strip/config — partial update
harbor.http.register(port=7000, method="POST", "/strip/config",
  fun(req, resp) -> begin
    body = req.body()

    let try_set = fun(key, r) -> begin
      pat = '"#{key}"\\s*:\\s*(-?[0-9.]+)'
      m = string.extract(pattern=pat, body)
      v = m[1] ?? ""
      if v != "" then
        r := string.to_float(default=r(), v)
        log("STRIP: #{key} = #{r()}")
      end
    end

    # Bypass
    bp_match = string.extract(pattern='"bypass"\\s*:\\s*(true|false)', body)
    bp_str = bp_match[1] ?? ""
    if bp_str == "false" then strip_bypass := false
    elsif bp_str == "true" then strip_bypass := true end

    try_set("gate_threshold", strip_gate_threshold)
    try_set("gate_attack", strip_gate_attack)
    try_set("gate_release", strip_gate_release)
    try_set("gate_hold", strip_gate_hold)
    try_set("gate_range", strip_gate_range)

    try_set("eq_low_freq", strip_eq_low_freq)
    try_set("eq_low_slope", strip_eq_low_slope)
    try_set("eq_mid_freq", strip_eq_mid_freq)
    try_set("eq_mid_gain", strip_eq_mid_gain)
    try_set("eq_mid_q", strip_eq_mid_q)
    try_set("eq_high_freq", strip_eq_high_freq)
    try_set("eq_high_slope", strip_eq_high_slope)

    try_set("comp_threshold", strip_comp_threshold)
    try_set("comp_ratio", strip_comp_ratio)
    try_set("comp_attack", strip_comp_attack)
    try_set("comp_release", strip_comp_release)
    try_set("comp_knee", strip_comp_knee)
    try_set("comp_makeup", strip_comp_makeup)

    try_set("lim_threshold", strip_lim_threshold)
    try_set("lim_attack", strip_lim_attack)
    try_set("lim_release", strip_lim_release)

    try_set("output_gain", strip_output_gain)

    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true, "bypass": #{strip_bypass()}}')
  end
)

# GET /strip/metering — данные для метров в UI
harbor.http.register(port=7000, method="GET", "/strip/metering",
  fun(_, resp) -> begin
    # Channel strip bypassed (Phase 2/3)
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"comp_gain": 0.0, "comp_rms": 0.0, "lim_gain": 0.0, "gate": 0.0}')
  end
)

# ---- VOICE (Push-to-Talk) ----

voice_duck = ref(0.1)   # Music volume during voice (0.0=silent, 1.0=full)
voice_gain = ref(5.0)   # Voice amplification factor

voice_src = source.on_track(voice_queue, fun(_) -> begin
  log("VOICE: playing (duck=#{voice_duck()}, gain=#{voice_gain()})")
end)

voice_src = amplify({ voice_gain() }, voice_src)

# Duck music when voice_queue is actively playing, full volume otherwise
# strip_out вместо processed — обработанная музыка
ducked_music = amplify({ if source.is_ready(voice_queue) then voice_duck() else 1.0 end }, strip_out)
final = fallback(track_sensitive=false, [add(normalize=false, [ducked_music, voice_src]), strip_out])

# Voice push endpoint
harbor.http.register(port=7000, method="POST", "/voice/push",
  fun(req, resp) -> begin
    body = req.body()
    path = string.trim(body)
    if path != "" then
      voice_queue.push(request.create(path))
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.data('{"ok": true, "path": "#{json_str(path)}"}')
    else
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.status_code(400)
      resp.data('{"error": "empty path"}')
    end
  end
)

# Voice config: GET
harbor.http.register(port=7000, method="GET", "/voice/config",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"duck": #{voice_duck()}, "gain": #{voice_gain()}}')
  end
)

# Voice config: POST (body: JSON with duck and/or gain)
harbor.http.register(port=7000, method="POST", "/voice/config",
  fun(req, resp) -> begin
    body = req.body()
    # Parse duck value
    duck_match = string.extract(pattern='"duck"\\s*:\\s*([0-9.]+)', body)
    gain_match = string.extract(pattern='"gain"\\s*:\\s*([0-9.]+)', body)
    duck_str = duck_match[1] ?? ""
    gain_str = gain_match[1] ?? ""
    if duck_str != "" then
      voice_duck := string.to_float(default=0.1, duck_str)
      log("VOICE: duck set to #{voice_duck()}")
    end
    if gain_str != "" then
      voice_gain := string.to_float(default=5.0, gain_str)
      log("VOICE: gain set to #{voice_gain()}")
    end
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true, "duck": #{voice_duck()}, "gain": #{voice_gain()}}')
  end
)

# ---- MIXING MODE ENDPOINTS ----

harbor.http.register(port=7000, method="GET", "/mixing/config",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"mode": "#{mix_mode()}"}')
  end
)

harbor.http.register(port=7000, method="POST", "/mixing/config",
  fun(req, resp) -> begin
    body = req.body()
    mode_match = string.extract(pattern='"mode"\\s*:\\s*"([a-z_]+)"', body)
    mode_str = mode_match[1] ?? ""
    if mode_str == "smart" or mode_str == "cut" or mode_str == "crossfade" then
      mix_mode := mode_str
      log("MIXING: mode changed to #{mode_str}")
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.data('{"ok": true, "mode": "#{json_str(mix_mode())}"}')
    else
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.status_code(400)
      resp.data('{"error": "invalid mode: #{json_str(mode_str)}"}')
    end
  end
)

# ---- PLAYBACK GATE ----
# When stopped, output silence to Icecast (keeps connection alive)

# Hard cut transitions — no crossfade on gate open/close
gated = switch(track_sensitive=false, transitions=[
  fun(_, b) -> b,
  fun(_, b) -> b
], [
  ({ dj_playing() }, final),
  ({ true }, blank())
])
gated = mksafe(gated)

# ---- AUTOPLAY ----
# Автоматически открыть gate через 8с после старта (cross buffer заполняется за ~5с,
# + 3с margin на медленный I/O). Если dashboard или пользователь вызвал /playback/resume
# раньше — таймер ничего не делает. /playback/stop отменяет autoplay.
autoplay_cancelled = ref(false)

thread.run(delay=8.0, fun() -> begin
  if not dj_playing() and not autoplay_cancelled() then
    fn = next_track()
    if fn != "" then
      dj_playing := true
      current_title := strip_ext(get_basename(fn))
      file.write(data=fn, "/shared/current_audio.txt")
      log("AUTOPLAY: gate auto-opened after initial buffer")
    else
      log("AUTOPLAY: no tracks loaded, staying silent")
    end
  end
end)

harbor.http.register(port=7000, method="POST", "/playback/stop",
  fun(_, resp) -> begin
    dj_playing := false
    autoplay_cancelled := true
    current_title := ""
    file.write(data="", "/shared/current_audio.txt")
    log("PLAYBACK: stopped")
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true, "playing": false}')
  end
)

harbor.http.register(port=7000, method="POST", "/playback/start",
  fun(_, resp) -> begin
    music.reload()
    source.skip(my_source)
    log("PLAYBACK: playlist reloaded + fresh track (gate unchanged)")
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true, "action": "prepared"}')
  end
)

harbor.http.register(port=7000, method="POST", "/playback/cue",
  fun(req, resp) -> begin
    body = req.body()
    path = string.trim(body)
    if path != "" then
      queue.push(request.create(path))
      queue_list := list.append(queue_list(), [path])
      log("PLAYBACK: cued #{path} into queue")
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.data('{"ok": true, "cued": "#{path}"}')
    else
      resp.content_type("application/json")
      resp.header("access-control-allow-origin", "*")
      resp.status_code(400)
      resp.data('{"error": "empty path"}')
    end
  end
)

harbor.http.register(port=7000, method="POST", "/playback/resume",
  fun(_, resp) -> begin
    dj_playing := true
    # Metadata пишет dashboard (cuedTrackPath) — НЕ next_track() (это из music rotation)
    log("PLAYBACK: gate opened")
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"ok": true, "playing": true}')
  end
)

harbor.http.register(port=7000, method="GET", "/playback/status",
  fun(_, resp) -> begin
    resp.content_type("application/json")
    resp.header("access-control-allow-origin", "*")
    resp.data('{"playing": #{dj_playing()}}')
  end
)

# ---- OUTPUT ----

output.icecast(
  %ffmpeg(format="adts", %audio(codec="aac", b="256k", ar=48000, channels=2)),
  host = "icecast", port = 8000, password = environment.get("ICECAST_SOURCE_PASSWORD"), mount = "/live",
  name = "STUDIO 23", genre = "Music",
  description = "STUDIO 23 — AutoDJ",
  gated
)
