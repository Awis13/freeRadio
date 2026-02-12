const http = require('http');
const os = require('os');
const fs = require('fs');

const METRICS_PORT = 9091;

class MetricsExporter {
  constructor() {
    this.metrics = {
      ffmpeg_connected: 0,
      ffmpeg_bitrate: 0,
      ffmpeg_fps: 0,
      youtube_connected: 0,
      kick_connected: 0,
      current_track_bpm: 0,
      current_track_duration: 0,
      analyzed_tracks: 0,
      cpu_usage: 0,
      memory_usage: 0,
    };
  }

  update(name, value) {
    this.metrics[name] = value;
  }

  getPrometheusFormat() {
    const lines = [];
    lines.push('# HELP s23_ffmpeg_connected FFmpeg connection status');
    lines.push('# TYPE s23_ffmpeg_connected gauge');
    lines.push(`s23_ffmpeg_connected ${this.metrics.ffmpeg_connected}`);
    
    lines.push('# HELP s23_ffmpeg_bitrate Current video bitrate');
    lines.push('# TYPE s23_ffmpeg_bitrate gauge');
    lines.push(`s23_ffmpeg_bitrate ${this.metrics.ffmpeg_bitrate}`);
    
    lines.push('# HELP s23_ffmpeg_fps Current FPS');
    lines.push('# TYPE s23_ffmpeg_fps gauge');
    lines.push(`s23_ffmpeg_fps ${this.metrics.ffmpeg_fps}`);
    
    lines.push('# HELP s23_youtube_connected YouTube RTMP connection');
    lines.push('# TYPE s23_youtube_connected gauge');
    lines.push(`s23_youtube_connected ${this.metrics.youtube_connected}`);
    
    lines.push('# HELP s23_kick_connected Kick RTMP connection');
    lines.push('# TYPE s23_kick_connected gauge');
    lines.push(`s23_kick_connected ${this.metrics.kick_connected}`);
    
    lines.push('# HELP s23_track_bpm Current track BPM');
    lines.push('# TYPE s23_track_bpm gauge');
    lines.push(`s23_track_bpm ${this.metrics.current_track_bpm}`);
    
    lines.push('# HELP s23_analyzed_tracks Total analyzed tracks');
    lines.push('# TYPE s23_analyzed_tracks gauge');
    lines.push(`s23_analyzed_tracks ${this.metrics.analyzed_tracks}`);
    
    // System metrics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    lines.push('# HELP s23_memory_usage_bytes Memory usage');
    lines.push('# TYPE s23_memory_usage_bytes gauge');
    lines.push(`s23_memory_usage_bytes ${usedMem}`);
    
    lines.push('# HELP s23_memory_total_bytes Total memory');
    lines.push('# TYPE s23_memory_total_bytes gauge');
    lines.push(`s23_memory_total_bytes ${totalMem}`);
    
    return lines.join('\n') + '\n';
  }

  start() {
    const server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(this.getPrometheusFormat());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    
    server.listen(METRICS_PORT, () => {
      console.log(`[metrics] Prometheus exporter on port ${METRICS_PORT}`);
    });
  }
}

module.exports = { MetricsExporter };
