// Channel Strip — пресеты, дефолты, диапазоны, валидация
const fs = require('fs');
const path = require('path');
const liqClient = require('./liqClient');

const CONFIG_PATH = '/shared/channel_strip.json';

// Диапазоны параметров для валидации
const PARAM_RANGES = {
  bypass:          { type: 'bool' },
  gate_threshold:  { min: -80, max: 0 },
  gate_attack:     { min: 0.1, max: 500 },
  gate_release:    { min: 10, max: 5000 },
  gate_hold:       { min: 0, max: 5000 },
  gate_range:      { min: -80, max: 0 },
  eq_low_freq:     { min: 20, max: 500 },
  eq_low_slope:    { min: -12, max: 12 },
  eq_mid_freq:     { min: 200, max: 8000 },
  eq_mid_gain:     { min: -12, max: 12 },
  eq_mid_q:        { min: 0.1, max: 10 },
  eq_high_freq:    { min: 2000, max: 16000 },
  eq_high_slope:   { min: -12, max: 12 },
  comp_threshold:  { min: -60, max: 0 },
  comp_ratio:      { min: 1, max: 20 },
  comp_attack:     { min: 0.1, max: 500 },
  comp_release:    { min: 10, max: 5000 },
  comp_knee:       { min: 0, max: 12 },
  comp_makeup:     { min: -12, max: 24 },
  lim_threshold:   { min: -20, max: 0 },
  lim_attack:      { min: 0.1, max: 500 },
  lim_release:     { min: 10, max: 5000 },
  output_gain:     { min: 0, max: 4 }
};

// Дефолтные значения (bypass=true)
const DEFAULTS = {
  bypass: true,
  gate_threshold: -30, gate_attack: 10, gate_release: 2000,
  gate_hold: 1000, gate_range: -30,
  eq_low_freq: 200, eq_low_slope: 0,
  eq_mid_freq: 1000, eq_mid_gain: 0, eq_mid_q: 1,
  eq_high_freq: 6000, eq_high_slope: 0,
  comp_threshold: -10, comp_ratio: 2, comp_attack: 50,
  comp_release: 400, comp_knee: 1, comp_makeup: 0,
  lim_threshold: -2, lim_attack: 50, lim_release: 200,
  output_gain: 1
};

// Пресеты
const PRESETS = {
  bypass: { ...DEFAULTS, bypass: true },

  clean_voice: {
    bypass: false,
    gate_threshold: -35, gate_attack: 10, gate_release: 2000,
    gate_hold: 1000, gate_range: -30,
    eq_low_freq: 200, eq_low_slope: 0,
    eq_mid_freq: 2500, eq_mid_gain: 2, eq_mid_q: 1,
    eq_high_freq: 6000, eq_high_slope: 0,
    comp_threshold: -18, comp_ratio: 3, comp_attack: 50,
    comp_release: 400, comp_knee: 1, comp_makeup: 2,
    lim_threshold: -1, lim_attack: 50, lim_release: 200,
    output_gain: 1
  },

  warm_radio: {
    bypass: false,
    gate_threshold: -40, gate_attack: 10, gate_release: 2000,
    gate_hold: 1000, gate_range: -30,
    eq_low_freq: 200, eq_low_slope: 3,
    eq_mid_freq: 800, eq_mid_gain: 1, eq_mid_q: 1,
    eq_high_freq: 6000, eq_high_slope: 0,
    comp_threshold: -14, comp_ratio: 4, comp_attack: 50,
    comp_release: 400, comp_knee: 2, comp_makeup: 3,
    lim_threshold: -1.5, lim_attack: 50, lim_release: 200,
    output_gain: 1
  },

  podcast: {
    bypass: false,
    gate_threshold: -30, gate_attack: 10, gate_release: 2000,
    gate_hold: 1000, gate_range: -30,
    eq_low_freq: 200, eq_low_slope: -3,
    eq_mid_freq: 3000, eq_mid_gain: 3, eq_mid_q: 1,
    eq_high_freq: 6000, eq_high_slope: 0,
    comp_threshold: -20, comp_ratio: 3.5, comp_attack: 50,
    comp_release: 400, comp_knee: 2, comp_makeup: 4,
    lim_threshold: -1, lim_attack: 50, lim_release: 200,
    output_gain: 1
  },

  lo_fi: {
    bypass: false,
    gate_threshold: -50, gate_attack: 10, gate_release: 2000,
    gate_hold: 1000, gate_range: -30,
    eq_low_freq: 250, eq_low_slope: 4,
    eq_mid_freq: 1000, eq_mid_gain: 0, eq_mid_q: 1,
    eq_high_freq: 6000, eq_high_slope: -4,
    comp_threshold: -8, comp_ratio: 6, comp_attack: 30,
    comp_release: 300, comp_knee: 3, comp_makeup: 2,
    lim_threshold: -3, lim_attack: 50, lim_release: 200,
    output_gain: 1
  }
};

// Валидация и клэмп параметров
function validateConfig(params) {
  const result = {};
  for (const [key, value] of Object.entries(params)) {
    const range = PARAM_RANGES[key];
    if (!range) continue;
    if (range.type === 'bool') {
      result[key] = !!value;
    } else {
      const num = parseFloat(value);
      if (isNaN(num)) continue;
      result[key] = Math.max(range.min, Math.min(range.max, num));
    }
  }
  return result;
}

// Сохранить конфиг в JSON файл
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('[channel-strip] save error:', e.message);
  }
}

// Загрузить конфиг из JSON файла
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[channel-strip] load error:', e.message);
  }
  return null;
}

// API: получить текущий конфиг из Liquidsoap
async function getConfig() {
  const res = await liqClient.getStripConfig();
  return res.data;
}

// API: установить параметры (partial update)
async function setConfig(params) {
  const validated = validateConfig(params);
  if (Object.keys(validated).length === 0) {
    return { ok: false, error: 'no valid params' };
  }

  // Отправляем в Liquidsoap
  const res = await liqClient.setStripConfig(validated);

  // Сохраняем полный конфиг в файл
  const fullConfig = await liqClient.getStripConfig();
  if (fullConfig.data) saveConfig(fullConfig.data);

  return res.data;
}

// API: применить пресет
async function setPreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    return { ok: false, error: 'unknown preset: ' + name };
  }

  const res = await liqClient.setStripConfig(preset);

  // Сохраняем в файл
  saveConfig(preset);

  return { ok: true, preset: name, data: res.data };
}

// API: получить metering данные
async function getMetering() {
  const res = await liqClient.getStripMetering();
  return res.data;
}

module.exports = {
  getConfig,
  setConfig,
  setPreset,
  getMetering,
  PRESETS,
  DEFAULTS,
  PARAM_RANGES,
  validateConfig,
  saveConfig,
  loadConfig
};
