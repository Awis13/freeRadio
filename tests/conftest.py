"""
Shared fixtures and bootstrap for the FreeRadio test suite.

IMPORTANT: essentia is injected into sys.modules at module-import time
(when conftest.py itself is loaded by pytest), not inside a fixture.
This ensures that `import audio_analyzer_simple` in the test file sees
the stub instead of the real library, which is not installed locally.
"""

import sys
import types
import os
from unittest.mock import MagicMock
import numpy as np
import pytest


# ---------------------------------------------------------------------------
# Inject essentia stub into sys.modules IMMEDIATELY (at conftest import time)
# so the module-level `import essentia; import essentia.standard as es` in
# audio_analyzer_simple.py resolves to our mocks during collection.
# ---------------------------------------------------------------------------

def _install_essentia_stub():
    essentia_mod = types.ModuleType("essentia")
    standard_mod = types.ModuleType("essentia.standard")

    # RhythmExtractor2013 — a MagicMock class that can be instantiated
    standard_mod.RhythmExtractor2013 = MagicMock(name="RhythmExtractor2013")
    # MonoLoader — a MagicMock class that can be instantiated
    standard_mod.MonoLoader = MagicMock(name="MonoLoader")

    essentia_mod.standard = standard_mod

    sys.modules["essentia"] = essentia_mod
    sys.modules["essentia.standard"] = standard_mod
    return essentia_mod, standard_mod


# Only install once (guard against re-import of conftest in some pytest modes)
if "essentia" not in sys.modules:
    _ESSENTIA_STUB, _ESSENTIA_STANDARD_STUB = _install_essentia_stub()
else:
    _ESSENTIA_STUB = sys.modules["essentia"]
    _ESSENTIA_STANDARD_STUB = sys.modules["essentia.standard"]


# ---------------------------------------------------------------------------
# Add the project root to sys.path so `import audio_analyzer_simple` works
# when pytest is invoked from any working directory.
# ---------------------------------------------------------------------------

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPTS_DIR = os.path.join(_PROJECT_ROOT, 'scripts')
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
if os.path.isdir(_SCRIPTS_DIR) and _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)


# ---------------------------------------------------------------------------
# Synthetic audio helpers
# ---------------------------------------------------------------------------

SR = 44100  # samples per second


def make_silence(duration_s, sr=SR):
    """Return a float32 numpy array of silence."""
    return np.zeros(int(duration_s * sr), dtype=np.float32)


def make_sine(duration_s, freq=440.0, amplitude=0.5, sr=SR):
    """Return a float32 numpy array containing a pure sine wave."""
    t = np.linspace(0, duration_s, int(duration_s * sr), endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def make_noise(duration_s, amplitude=0.5, sr=SR, seed=42):
    """Return a float32 numpy array of white noise."""
    rng = np.random.default_rng(seed)
    return (amplitude * rng.standard_normal(int(duration_s * sr))).astype(np.float32)


def make_silent_then_audio(silence_s, audio_s, sr=SR):
    """Return silence followed by a sine wave."""
    return np.concatenate([make_silence(silence_s, sr), make_sine(audio_s, sr=sr)])


def beats_for_bpm(bpm, duration_s, first_beat=0.0):
    """Return a list of beat timestamps at a fixed BPM."""
    beat_period = 60.0 / bpm
    beats = []
    t = first_beat
    while t < duration_s:
        beats.append(t)
        t += beat_period
    return beats


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def silence_5s():
    return make_silence(5.0)


@pytest.fixture
def sine_10s():
    return make_sine(10.0)


@pytest.fixture
def noise_30s():
    return make_noise(30.0)
