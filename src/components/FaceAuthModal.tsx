import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, UserCheck, ScanFace, Loader2 } from 'lucide-react';
import {
  loadFaceModels, registerFace, verifyFace, isFaceRegistered,
  startCamera, stopCamera, clearFaceRegistration,
} from '../lib/faceAuth';

type Mode = 'register' | 'verify';

export default function FaceAuthModal({
  onClose,
  onSuccess,
  mode,
}: {
  onClose: () => void;
  onSuccess: () => void;
  mode: Mode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'scanning' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('正在加载人脸模型...');
  const [registered, setRegistered] = useState(false);
  const [score, setScore] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRegistered(isFaceRegistered());
      const ok = await loadFaceModels();
      if (cancelled) return;
      if (!ok) {
        setStatus('error');
        setMessage('模型加载失败，请检查网络后重试');
        return;
      }
      const stream = await startCamera();
      if (cancelled) { stopCamera(stream); return; }
      if (!stream) {
        setStatus('error');
        setMessage('无法访问摄像头，请授权摄像头权限');
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStatus('ready');
      setMessage(mode === 'register' ? '请正对摄像头，点击下方按钮录入人脸' : '请正对摄像头，点击下方按钮验证');
    })();
    return () => {
      cancelled = true;
      stopCamera(streamRef.current);
    };
  }, [mode]);

  const handleAction = async () => {
    if (!videoRef.current || status !== 'ready') return;
    setStatus('scanning');
    setMessage('正在扫描人脸...');
    // 等一帧让画面稳定
    await new Promise((r) => setTimeout(r, 500));
    if (mode === 'register') {
      const ok = await registerFace(videoRef.current);
      if (ok) {
        setStatus('success');
        setMessage('人脸录入成功！下次可直接刷脸');
        setTimeout(() => { onSuccess(); }, 1200);
      } else {
        setStatus('ready');
        setMessage('未检测到清晰人脸，请调整光线和角度重试');
      }
    } else {
      const result = await verifyFace(videoRef.current);
      setScore(result.score);
      if (result.match) {
        setStatus('success');
        setMessage(`验证成功！相似度 ${(result.score * 100).toFixed(0)}%`);
        setTimeout(() => { onSuccess(); }, 1000);
      } else {
        setStatus('ready');
        setMessage(`验证失败（相似度 ${(result.score * 100).toFixed(0)}%），请重试或输入密码`);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-[360px] bg-white rounded-3xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-[#015F7B]">
          <div className="flex items-center gap-2">
            <ScanFace className="w-5 h-5 text-white" />
            <p className="text-white font-bold text-[15px]">
              {mode === 'register' ? '录入人脸' : '人脸验证'}
            </p>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Camera preview */}
        <div className="relative bg-black aspect-square">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover transform scale-x-[-1]"
          />
          {/* Face guide circle */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className={`w-52 h-52 rounded-full border-4 ${
              status === 'success' ? 'border-green-400' : status === 'scanning' ? 'border-yellow-400 animate-pulse' : 'border-white/50'
            }`} />
          </div>
          {status === 'scanning' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-10 h-10 text-white animate-spin" />
            </div>
          )}
          {status === 'success' && (
            <div className="absolute inset-0 flex items-center justify-center bg-green-500/20">
              <UserCheck className="w-16 h-16 text-green-400" />
            </div>
          )}
        </div>

        {/* Status + actions */}
        <div className="p-5">
          <p className={`text-center text-[13px] font-semibold mb-4 ${
            status === 'success' ? 'text-green-600' : status === 'error' ? 'text-red-500' : 'text-gray-600'
          }`}>
            {message}
          </p>

          {status !== 'success' && status !== 'error' && (
            <button
              onClick={handleAction}
              disabled={status !== 'ready'}
              className="w-full flex items-center justify-center gap-2 bg-[#015F7B] text-white font-bold py-3.5 rounded-2xl active:opacity-80 disabled:opacity-40"
            >
              <Camera className="w-5 h-5" />
              {mode === 'register' ? '录入我的人脸' : '刷脸验证'}
            </button>
          )}

          {mode === 'register' && registered && (
            <button
              onClick={() => { clearFaceRegistration(); setRegistered(false); }}
              className="w-full mt-3 text-[12px] text-red-500 font-semibold py-2"
            >
              清除已录入的人脸
            </button>
          )}

          <button
            onClick={onClose}
            className="w-full mt-2 text-[13px] text-gray-500 font-semibold py-2"
          >
            {mode === 'register' ? '取消，用密码登录' : '取消，改用密码'}
          </button>
        </div>
      </div>
    </div>
  );
}
