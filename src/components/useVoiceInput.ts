import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 语音输入 hook（灵境声纹）
 * - 优先用 getUserMedia + Web Audio AnalyserNode 画出真实声纹
 * - 同时尝试 SpeechRecognition 把语音转成文字填入输入框
 * - 浏览器不支持麦克风时退化为合成声纹（纯视觉反馈），保证交互不破
 * 返回：recording（是否在录）、toggle（开/关）、waveRef（声纹 canvas 引用）
 */
interface Options {
  onTranscript: (text: string, isFinal: boolean) => void;
  warm?: boolean;
}

export function useVoiceInput({ onTranscript, warm = false }: Options) {
  const [recording, setRecording] = useState(false);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>();
  const srRef = useRef<SpeechRecognitionLike | null>(null);
  const warmRef = useRef(warm);
  warmRef.current = warm;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const draw = useCallback(() => {
    const cv = waveRef.current;
    if (!cv) return;
    const c = cv.getContext('2d');
    if (!c) return;
    const w = cv.width || 300;
    const h = cv.height || 60;
    c.clearRect(0, 0, w, h);
    const an = analyserRef.current;
    const gold = warmRef.current;
    const bars = 42;
    const bw = w / bars;
    if (an) {
      const buf = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(buf);
      for (let i = 0; i < bars; i++) {
        const v = buf[Math.floor((i / bars) * buf.length)] / 255;
        const bh = Math.max(2, v * h * 0.92);
        c.fillStyle = gold ? `hsl(${38 + (i % 6)}, 80%, 66%)` : `hsl(${192 + i * 1.4}, 80%, 68%)`;
        c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 2), bh);
      }
    } else {
      // 合成声纹（无麦克风权限时）
      for (let i = 0; i < bars; i++) {
        const v = 0.3 + 0.7 * Math.abs(Math.sin(Date.now() / 180 + i * 0.5));
        const bh = Math.max(2, v * h * 0.8);
        c.fillStyle = gold ? `hsl(${38 + (i % 6)}, 80%, 66%)` : `hsl(${192 + i * 1.4}, 80%, 68%)`;
        c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 2), bh);
      }
    }
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  const stop = useCallback(() => {
    setRecording(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (srRef.current) {
      try { srRef.current.stop(); } catch { /* noop */ }
      srRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch { /* noop */ }
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    const cv = waveRef.current;
    if (cv) {
      const c = cv.getContext('2d');
      if (c) c.clearRect(0, 0, cv.width, cv.height);
    }
  }, []);

  const start = useCallback(async () => {
    const cv = waveRef.current;
    if (cv) {
      const rect = cv.getBoundingClientRect();
      cv.width = Math.max(120, Math.floor(rect.width)) || 300;
      cv.height = Math.max(40, Math.floor(rect.height)) || 60;
    }
    // SpeechRecognition（尽力而为）
    try {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SR) {
        const rec: SpeechRecognitionLike = new SR();
        rec.lang = 'zh-CN';
        rec.continuous = false;
        rec.interimResults = true;
        rec.onresult = (e: any) => {
          let finalT = '';
          let interimT = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) finalT += t; else interimT += t;
          }
          onTranscriptRef.current(finalT || interimT, !!finalT);
        };
        rec.onerror = () => { /* 静默 */ };
        rec.start();
        srRef.current = rec;
      }
    } catch { /* noop */ }

    // 麦克风声纹
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ac: AudioContext = new AC();
      audioCtxRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 128;
      src.connect(an);
      analyserRef.current = an;
    } catch {
      analyserRef.current = null; // 走合成声纹
    }

    setRecording(true);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  const toggle = useCallback(() => {
    if (recording) stop(); else start();
  }, [recording, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { recording, toggle, waveRef };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
}
