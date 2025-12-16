import React, { useState, useRef } from 'react';
import { UploadedMedia, AudioTrack, AppState, VideoSettings, TransitionType, CollageData, CanvasItem, SavedProject, SavedMediaItem } from './types';
import VideoPreview from './components/VideoPreview';
import CollageGenerator, { FONTS, EFFECTS_LIST } from './components/CollageGenerator';

const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
};

// Helper to get a random concrete transition
const getRandomTransition = (): TransitionType => {
    const types = Object.values(TransitionType);
    const randomIndex = Math.floor(Math.random() * types.length);
    return types[randomIndex];
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  
  // 'media' is the Timeline Sequence (can contain raw photos OR collages)
  const [media, setMedia] = useState<UploadedMedia[]>([]);
  // 'rawMedia' is the Library (contains ALL uploaded photos/videos, never deleted by collage creation)
  const [rawMedia, setRawMedia] = useState<UploadedMedia[]>([]);
  
  // Selection state for editing timeline items (text overlay, etc)
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  // Controls which slide the preview should jump to
  const [previewIndex, setPreviewIndex] = useState<number | undefined>(undefined);

  const [usedMediaIds, setUsedMediaIds] = useState<Set<string>>(new Set());
  
  // Changed from single object to Array to support playlist
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoExtension, setVideoExtension] = useState<string>('.webm');
  
  // Drag State
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);

  // Default Settings (4:3 Ratio)
  const [settings, setSettings] = useState<VideoSettings>({
    photoDuration: 3,
    transitionDuration: 1,
    resolution: { width: 960, height: 720 }, // 4:3 
    collageTitle: "My Memories"
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const handleMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files) as File[];
      const newItems: UploadedMedia[] = [];

      let processedCount = 0;

      const checkFinish = () => {
          processedCount++;
          if (processedCount === files.length) {
              setMedia(prev => {
                  const updated = prev.map(m => {
                      if (m.missing && newItems.some(n => n.fileName === m.fileName)) {
                          const match = newItems.find(n => n.fileName === m.fileName)!;
                          return { ...m, file: match.file, previewUrl: match.previewUrl, missing: false };
                      }
                      return m;
                  });
                  return [...updated, ...newItems];
              });
              
              setRawMedia(prev => {
                  const updatedRaw = prev.map(m => {
                      if (m.missing && newItems.some(n => n.fileName === m.fileName)) {
                           const match = newItems.find(n => n.fileName === m.fileName)!;
                           return { ...m, file: match.file, previewUrl: match.previewUrl, missing: false };
                      }
                      return m;
                  });
                   return [...updatedRaw, ...newItems];
              });
          }
      };

      files.forEach(file => {
        const isVideo = file.type.startsWith('video/');
        const url = URL.createObjectURL(file);
        const initialTransition = getRandomTransition();

        if (isVideo) {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = () => {
                const item: UploadedMedia = {
                    id: crypto.randomUUID(),
                    file,
                    type: 'video',
                    previewUrl: url,
                    fileName: file.name,
                    duration: video.duration,
                    enableOriginalAudio: true, 
                    overlayEffects: [],
                    transition: initialTransition
                };
                newItems.push(item);
                checkFinish();
            };
            video.src = url;
        } else {
            const item: UploadedMedia = {
                id: crypto.randomUUID(),
                file,
                type: 'image',
                fileName: file.name,
                previewUrl: url,
                overlayEffects: [],
                transition: initialTransition
            };
            newItems.push(item);
            checkFinish();
        }
      });

      if (appState === AppState.FINISHED) {
          setAppState(AppState.IDLE);
          setVideoUrl(null);
      }
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files: File[] = Array.from(e.target.files);
      const newTracks: AudioTrack[] = [];
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass();

      for (const file of files) {
          const url = URL.createObjectURL(file);
          let duration = 0;

          try {
              // Get Duration
              const arrayBuffer = await file.arrayBuffer();
              const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
              duration = audioBuffer.duration;
          } catch (err) {
              console.warn("Audio analysis failed, using fallback duration", err);
              // Fallback if decode fails (rare)
              const audio = new Audio(url);
              await new Promise((resolve) => { audio.onloadedmetadata = () => resolve(true); });
              duration = audio.duration;
          }
          
          newTracks.push({
            file,
            url: url,
            name: file.name,
            duration: duration
          });
      }
      
      if (ctx.state !== 'closed') ctx.close();

      setAudioTracks(prev => {
          const updated = prev.map(t => {
              if (t.missing && newTracks.some(n => n.name === t.name)) {
                  const match = newTracks.find(n => n.name === t.name)!;
                  return { ...t, file: match.file, url: match.url, missing: false };
              }
              return t;
          });
          const uniqueNew = newTracks.filter(n => !prev.some(p => p.missing && p.name === n.name));
          return [...updated, ...uniqueNew];
      });
    }
  };

  const removeAudioTrack = (index: number) => {
      setAudioTracks(prev => prev.filter((_, i) => i !== index));
  };

  const handleStartCollage = () => {
      if (media.length === 0) return;
      setAppState(AppState.COLLAGE);
  };

  const handleCollageSave = async (collageBlob: Blob, selectedIds: string[], collageData: CollageData, existingId?: string) => {
      setUsedMediaIds(prev => {
          const next = new Set(prev);
          selectedIds.forEach(id => next.add(id));
          return next;
      });

      const collageUrl = URL.createObjectURL(collageBlob);
      const collageFile = new File([collageBlob], `collage-${Date.now()}.png`, { type: "image/png" });
      
      const collageItem: UploadedMedia = {
          id: existingId || crypto.randomUUID(),
          file: collageFile,
          type: 'image',
          fileName: `collage-${Date.now()}.png`,
          previewUrl: collageUrl,
          collageData: collageData,
          overlayEffects: [],
          transition: getRandomTransition() 
      };
      
      setMedia(prev => {
          if (existingId) {
             const index = prev.findIndex(m => m.id === existingId);
             if (index !== -1) {
                 const newMedia = [...prev];
                 collageItem.transition = newMedia[index].transition;
                 newMedia[index] = collageItem;
                 return newMedia;
             }
          }
          const filtered = prev.filter(m => !selectedIds.includes(m.id));
          return [collageItem, ...filtered];
      });
  };

  const handleCollageFinish = () => {
      setAppState(AppState.EDITING);
  };

  const handleBackToCollage = () => {
      setAppState(AppState.COLLAGE);
  };

  const handleRender = () => {
    setAppState(AppState.RENDERING);
    setSelectedMediaId(null);
  };

  const handleRenderingComplete = (url: string, extension: string) => {
    setVideoUrl(url);
    setVideoExtension(extension);
    setAppState(AppState.FINISHED);
  };

  const removeMedia = (index: number) => {
      const newMedia = media.filter((_, i) => i !== index);
      setMedia(newMedia);
      if (selectedMediaId === media[index].id) setSelectedMediaId(null);
  };

  const toggleVideoAudio = (index: number) => {
      setMedia(prev => {
          const newMedia = [...prev];
          const item = newMedia[index];
          if (item.type === 'video') {
              newMedia[index] = { ...item, enableOriginalAudio: !item.enableOriginalAudio };
          }
          return newMedia;
      });
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
      setDraggedItemIndex(index);
      e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
      e.preventDefault();
      if (draggedItemIndex === null || draggedItemIndex === index) return;
      const newMedia = [...media];
      const draggedItem = newMedia[draggedItemIndex];
      newMedia.splice(draggedItemIndex, 1);
      newMedia.splice(index, 0, draggedItem);
      setMedia(newMedia);
      setDraggedItemIndex(index);
  };

  const handleDragEnd = () => {
      setDraggedItemIndex(null);
  };

  const reset = () => {
      setMedia([]);
      setRawMedia([]);
      setUsedMediaIds(new Set());
      setAudioTracks([]);
      setVideoUrl(null);
      setVideoExtension('.webm');
      setAppState(AppState.IDLE);
      setSelectedMediaId(null);
  };

  const handleSaveProject = async () => {
      const serializedMedia: SavedMediaItem[] = await Promise.all(media.map(async (m) => {
          const { file, previewUrl, ...rest } = m;
          let fileData = undefined;
          if (m.collageData && m.file) {
              fileData = await blobToBase64(m.file);
          }
          return { ...rest, fileData };
      }));
      
      const serializedRawMedia: SavedMediaItem[] = rawMedia.map(m => {
          const { file, previewUrl, ...rest } = m;
          return { ...rest };
      });

      const serializedAudio = audioTracks.map(t => {
          const { file, url, ...rest } = t;
          return { ...rest };
      });

      const project: SavedProject = {
          version: 1,
          timestamp: Date.now(),
          settings,
          media: serializedMedia,
          rawMedia: serializedRawMedia,
          audioTracks: serializedAudio
      };

      const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `memory-reel-project-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  const handleLoadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files[0]) {
          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = async (event) => {
              try {
                  const project: SavedProject = JSON.parse(event.target?.result as string);
                  setSettings(project.settings);
                  
                  const restoredMedia: UploadedMedia[] = await Promise.all(project.media.map(async (m) => {
                      if (m.collageData && m.fileData) {
                          const res = await fetch(m.fileData);
                          const blob = await res.blob();
                          const file = new File([blob], m.fileName || 'collage.png', { type: 'image/png' });
                          return { ...m, file, type: 'image', previewUrl: URL.createObjectURL(blob), missing: false, transition: m.transition || getRandomTransition() } as UploadedMedia;
                      } else {
                          return { ...m, type: m.type, previewUrl: '', missing: true, transition: m.transition || getRandomTransition() } as UploadedMedia;
                      }
                  }));
                  setMedia(restoredMedia);

                  const restoredRaw = project.rawMedia.map(m => ({ ...m, type: m.type, previewUrl: '', missing: true } as UploadedMedia));
                  setRawMedia(restoredRaw);

                  setAudioTracks(project.audioTracks.map(t => ({ ...t, url: '', missing: true } as AudioTrack)));

                  setAppState(AppState.EDITING);

              } catch (err) {
                  console.error("Load failed", err);
                  alert("無法讀取專案檔案，格式可能不正確。");
              }
          };
          reader.readAsText(file);
      }
      if (projectInputRef.current) projectInputRef.current.value = '';
  };

  const handleMediaUpdate = (id: string, updates: Partial<UploadedMedia>) => {
      setMedia(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  };

  const handleBatchUpdateTransition = (val: string) => {
      if (val === 'RANDOM_ALL') {
          setMedia(prev => prev.map(m => ({ ...m, transition: getRandomTransition() })));
      } else {
          setMedia(prev => prev.map(m => ({ ...m, transition: val as TransitionType })));
      }
  };

  const handleAddText = () => {
      if (!selectedMediaId) return;
      const defaultText: CanvasItem = {
          id: 'overlay',
          type: 'text',
          text: '請輸入文字',
          x: settings.resolution.width / 2,
          y: settings.resolution.height / 2,
          width: 0,
          height: 0,
          scale: 1,
          zIndex: 100,
          fontSize: 60,
          fontFamily: FONTS[0].value,
          color: '#ffffff',
          strokeColor: '#000000',
          strokeWidth: 4,
          imgOffset: {x:0, y:0},
          imgZoom: 1
      };
      
      handleMediaUpdate(selectedMediaId, { overlayText: defaultText });
  };

  const handleAddEffect = (animId: string) => {
      if (!selectedMediaId) return;
      const m = media.find(m => m.id === selectedMediaId);
      if (!m) return;
      
      const newEffect: CanvasItem = {
          id: `effect-${Date.now()}`,
          type: 'effect',
          x: settings.resolution.width / 2,
          y: settings.resolution.height / 2,
          width: 100,
          height: 100,
          scale: 1,
          zIndex: 100 + (m.overlayEffects?.length || 0),
          animationType: animId as any
      };
      
      handleMediaUpdate(selectedMediaId, { 
          overlayEffects: [...(m.overlayEffects || []), newEffect] 
      });
  };

  const handleRemoveEffect = (effectId: string) => {
      if (!selectedMediaId) return;
      const m = media.find(m => m.id === selectedMediaId);
      if (!m || !m.overlayEffects) return;

      handleMediaUpdate(selectedMediaId, {
          overlayEffects: m.overlayEffects.filter(e => e.id !== effectId)
      });
  };

  const handleUpdateText = (updates: Partial<CanvasItem>) => {
      if (!selectedMediaId) return;
      const m = media.find(i => i.id === selectedMediaId);
      if (m && m.overlayText) {
          handleMediaUpdate(selectedMediaId, { overlayText: { ...m.overlayText, ...updates } });
      }
  };

  const handleRemoveText = () => {
      if (!selectedMediaId) return;
      handleMediaUpdate(selectedMediaId, { overlayText: undefined });
  };

  const handleSelectMedia = (id: string, index: number) => {
      setSelectedMediaId(id);
      setPreviewIndex(index);
  };

  const transitionLabels: Record<TransitionType, string> = {
      [TransitionType.FADE]: '淡化 (Fade)',
      [TransitionType.SLIDE_UP]: '向上 (Slide Up)',
      [TransitionType.SLIDE_DOWN]: '向下 (Slide Down)',
      [TransitionType.SLIDE_LEFT]: '向左 (Slide Left)',
      [TransitionType.SLIDE_RIGHT]: '向右 (Slide Right)',
      [TransitionType.ZOOM_IN]: '緩慢放大 (Zoom In)',
      [TransitionType.ZOOM_OUT]: '緩慢縮小 (Zoom Out)',
  };

  const selectedMediaItem = media.find(m => m.id === selectedMediaId);
  const missingFilesCount = media.filter(m => m.missing).length + audioTracks.filter(t => t.missing).length;

  return (
    <div className="h-screen w-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">
      <header className="shrink-0 max-w-full mx-auto w-full px-6 py-4 flex justify-between items-center bg-slate-900 border-b border-slate-800 z-50">
        <div>
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
            AI Memory Reel
            </h1>
            <p className="text-slate-400 text-sm">自動拼貼與音樂剪輯</p>
        </div>
        <div className="flex gap-3">
             <input 
                type="file" 
                ref={projectInputRef}
                accept=".json" 
                className="hidden" 
                onChange={handleLoadProject}
             />
             <button onClick={() => projectInputRef.current?.click()} className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm transition">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                載入專案
             </button>
             {media.length > 0 && (
                 <button onClick={handleSaveProject} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-bold transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                    儲存專案
                 </button>
             )}
             {appState !== AppState.IDLE && (
                <button onClick={reset} className="text-xs text-slate-500 hover:text-white underline ml-4">
                    重新開始
                </button>
             )}
        </div>
      </header>

      {/* Main Content Area - Fill remaining height */}
      <main className="flex-1 overflow-y-auto lg:overflow-hidden relative scrollbar-thin">
          
          {appState === AppState.COLLAGE ? (
              <CollageGenerator 
                media={rawMedia}
                createdCollages={media.filter(m => !!m.collageData)}
                title={settings.collageTitle}
                onTitleChange={(t) => setSettings(s => ({...s, collageTitle: t}))}
                usedMediaIds={usedMediaIds}
                onSave={handleCollageSave}
                onFinish={handleCollageFinish}
              />
          ) : (
            <div className="lg:h-full w-full max-w-[1920px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-0">
                
                {/* Left Column: Controls (Scrollable) */}
                <div className="lg:col-span-4 xl:col-span-3 lg:h-full lg:overflow-y-auto bg-slate-900 border-r border-slate-800 scrollbar-thin flex flex-col">
                    <div className="flex-1 p-6">
                        {/* Missing Files Warning */}
                        {missingFilesCount > 0 && (
                            <div className="mb-6 bg-amber-900/30 border border-amber-600 rounded-lg p-4 flex items-center gap-3 animate-pulse">
                                <svg className="w-6 h-6 text-amber-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                <div>
                                    <h3 className="font-bold text-amber-500 text-sm">專案中有 {missingFilesCount} 個檔案遺失</h3>
                                    <p className="text-xs text-slate-300">請在下方重新上傳原始檔案</p>
                                </div>
                            </div>
                        )}

                        {/* Upload Section */}
                        <div className="bg-slate-800 rounded-xl p-6 shadow-lg border border-slate-700 mb-6">
                            <h2 className="text-xl font-semibold mb-4 text-white">1. 上傳素材</h2>
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-2">照片/影片 ({rawMedia.length})</label>
                                    <input
                                        type="file" multiple accept="image/*,video/*"
                                        ref={fileInputRef} onChange={handleMediaUpload}
                                        className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-2">音樂</label>
                                    <input
                                        type="file" accept="audio/*" multiple
                                        ref={audioInputRef} onChange={handleAudioUpload}
                                        className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-purple-600 file:text-white hover:file:bg-purple-700 cursor-pointer"
                                    />
                                    {audioTracks.length > 0 && (
                                        <div className="mt-3 space-y-2 bg-slate-900/50 p-2 rounded max-h-[120px] overflow-y-auto scrollbar-thin">
                                            {audioTracks.map((track, idx) => (
                                                <div key={idx} className={`flex justify-between items-center text-xs ${track.missing ? 'text-red-400' : 'text-slate-300'}`}>
                                                    <div className="flex items-center gap-2 overflow-hidden">
                                                        <span className="text-purple-400 font-bold">{idx + 1}.</span>
                                                        <div className="flex flex-col truncate">
                                                             <span className="truncate">{track.missing ? `[遺失] ${track.name}` : track.name}</span>
                                                        </div>
                                                    </div>
                                                    <button onClick={() => removeAudioTrack(idx)} className="text-slate-500 hover:text-red-400 px-2">✕</button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                            {media.length > 0 && appState === AppState.IDLE && (
                                <button onClick={handleStartCollage} className="w-full mt-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-bold rounded-lg shadow hover:opacity-90 transition">
                                    下一步: 製作拼貼
                                </button>
                            )}
                        </div>

                        {/* Manual Controls (Settings) */}
                        {(appState === AppState.EDITING || appState === AppState.FINISHED) && (
                            <div className="bg-slate-800 rounded-xl p-6 shadow-lg border border-slate-700 flex flex-col gap-4">
                                <h2 className="text-xl font-semibold text-white shrink-0">3. 影片設定</h2>
                                
                                {/* Selected Item Editor */}
                                {selectedMediaItem && (
                                    <div className="shrink-0 bg-blue-900/20 border border-blue-500/50 p-3 rounded-lg animate-fade-in">
                                        <div className="flex justify-between items-center mb-2">
                                            <label className="block text-xs font-bold text-blue-300 uppercase">
                                                物件疊加 (素材 #{media.findIndex(m => m.id === selectedMediaId) + 1})
                                            </label>
                                            <button onClick={() => setSelectedMediaId(null)} className="text-slate-400 hover:text-white">
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </div>

                                        {/* Text Overlay Section */}
                                        <div className="mb-4">
                                            <h4 className="text-xs font-bold text-slate-400 mb-2 border-b border-slate-700 pb-1">文字</h4>
                                            {!selectedMediaItem.overlayText ? (
                                                <button onClick={handleAddText} className="w-full py-2 border border-dashed border-blue-500 text-blue-400 rounded hover:bg-blue-500/10 text-xs font-bold">
                                                    + 新增文字
                                                </button>
                                            ) : (
                                                <div className="space-y-2">
                                                    <textarea
                                                        rows={3}
                                                        value={selectedMediaItem.overlayText.text || ''}
                                                        onChange={(e) => handleUpdateText({ text: e.target.value })}
                                                        className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-sm text-white focus:border-blue-500 resize-none"
                                                        placeholder="輸入文字 (可換行)..."
                                                    />
                                                    <div className="flex gap-2">
                                                        <select 
                                                            value={selectedMediaItem.overlayText.fontFamily}
                                                            onChange={(e) => handleUpdateText({ fontFamily: e.target.value })}
                                                            className="flex-1 bg-slate-900 border border-slate-600 rounded p-1 text-xs text-white"
                                                        >
                                                            {FONTS.map(f => <option key={f.name} value={f.value}>{f.name}</option>)}
                                                        </select>
                                                        <input 
                                                            type="color" value={selectedMediaItem.overlayText.color || '#ffffff'}
                                                            onChange={(e) => handleUpdateText({ color: e.target.value })}
                                                            className="w-8 h-6 rounded cursor-pointer border-none bg-transparent"
                                                        />
                                                    </div>

                                                    {/* Text Outline Section */}
                                                    <div className="mt-2 pt-2 border-t border-slate-700">
                                                         <div className="flex justify-between items-center mb-1">
                                                            <label className="text-xs text-slate-400">文字外框</label>
                                                            <input 
                                                                type="color" 
                                                                value={selectedMediaItem.overlayText.strokeColor || '#ffffff'}
                                                                onChange={(e) => handleUpdateText({ strokeColor: e.target.value, strokeWidth: selectedMediaItem.overlayText?.strokeWidth || 2 })}
                                                                className="w-5 h-5 rounded cursor-pointer border-none bg-transparent"
                                                            />
                                                         </div>
                                                         <div className="flex items-center gap-2">
                                                             <input 
                                                                type="range" min="0" max="20" step="0.5"
                                                                value={selectedMediaItem.overlayText.strokeWidth || 0}
                                                                onChange={(e) => handleUpdateText({ strokeWidth: parseFloat(e.target.value) })}
                                                                className="w-full h-1 bg-slate-700 rounded appearance-none accent-blue-500"
                                                             />
                                                             <span className="text-[10px] text-slate-500 w-4">{selectedMediaItem.overlayText.strokeWidth || 0}</span>
                                                         </div>
                                                    </div>
                                                    
                                                    {/* Background Settings */}
                                                    <div className="mt-2 pt-2 border-t border-slate-700">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <label className="text-xs text-slate-400">背景底框</label>
                                                            <input 
                                                                type="checkbox" 
                                                                checked={!!selectedMediaItem.overlayText.backgroundColor}
                                                                onChange={(e) => handleUpdateText({ 
                                                                    backgroundColor: e.target.checked ? '#000000' : undefined,
                                                                    backgroundOpacity: 0.7,
                                                                    backgroundPadding: 10,
                                                                    backgroundRadius: 4
                                                                })}
                                                                className="w-4 h-4 rounded border-slate-600 bg-slate-700 accent-blue-500"
                                                            />
                                                        </div>
                                                        {selectedMediaItem.overlayText.backgroundColor && (
                                                            <div className="space-y-2 pl-2 border-l-2 border-slate-700">
                                                                <div className="flex items-center justify-between">
                                                                    <span className="text-[10px] text-slate-500">顏色</span>
                                                                    <input 
                                                                        type="color" 
                                                                        value={selectedMediaItem.overlayText.backgroundColor}
                                                                        onChange={(e) => handleUpdateText({ backgroundColor: e.target.value })}
                                                                        className="w-6 h-6 rounded cursor-pointer border-none bg-transparent"
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <div className="flex justify-between text-[10px] text-slate-500"><span>透明度</span><span>{(selectedMediaItem.overlayText.backgroundOpacity || 0.7).toFixed(1)}</span></div>
                                                                    <input type="range" min="0" max="1" step="0.1" 
                                                                        value={selectedMediaItem.overlayText.backgroundOpacity ?? 0.7}
                                                                        onChange={(e) => handleUpdateText({ backgroundOpacity: parseFloat(e.target.value) })}
                                                                        className="w-full h-1 bg-slate-700 rounded appearance-none accent-blue-500"
                                                                    />
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-2">
                                                                    <div>
                                                                        <div className="flex justify-between text-[10px] text-slate-500"><span>內距</span><span>{selectedMediaItem.overlayText.backgroundPadding || 10}</span></div>
                                                                        <input type="range" min="0" max="50" step="1"
                                                                            value={selectedMediaItem.overlayText.backgroundPadding ?? 10}
                                                                            onChange={(e) => handleUpdateText({ backgroundPadding: parseInt(e.target.value) })}
                                                                            className="w-full h-1 bg-slate-700 rounded appearance-none accent-blue-500"
                                                                        />
                                                                    </div>
                                                                    <div>
                                                                        <div className="flex justify-between text-[10px] text-slate-500"><span>圓角</span><span>{selectedMediaItem.overlayText.backgroundRadius || 4}</span></div>
                                                                        <input type="range" min="0" max="50" step="1"
                                                                            value={selectedMediaItem.overlayText.backgroundRadius ?? 4}
                                                                            onChange={(e) => handleUpdateText({ backgroundRadius: parseInt(e.target.value) })}
                                                                            className="w-full h-1 bg-slate-700 rounded appearance-none accent-blue-500"
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>

                                                    <button onClick={handleRemoveText} className="text-xs text-red-400 hover:underline mt-2">移除文字</button>
                                                </div>
                                            )}
                                        </div>

                                        {/* Effect Overlay Section */}
                                        <div>
                                            <h4 className="text-xs font-bold text-slate-400 mb-2 border-b border-slate-700 pb-1">動態貼紙</h4>
                                            <div className="grid grid-cols-4 gap-2 mb-2">
                                                {EFFECTS_LIST.map(eff => (
                                                    <button 
                                                        key={eff.id} onClick={() => handleAddEffect(eff.id)}
                                                        className="bg-slate-700 hover:bg-slate-600 p-1 rounded text-[10px] text-center"
                                                        title={eff.name}
                                                    >
                                                        {eff.name}
                                                    </button>
                                                ))}
                                            </div>
                                            {selectedMediaItem.overlayEffects && selectedMediaItem.overlayEffects.length > 0 && (
                                                <div className="space-y-1">
                                                    {selectedMediaItem.overlayEffects.map((eff, i) => (
                                                        <div key={eff.id} className="flex justify-between items-center text-xs bg-slate-900 p-1 rounded">
                                                            <span>貼紙 {i+1}</span>
                                                            <button onClick={() => handleRemoveEffect(eff.id)} className="text-red-400 hover:text-white">✕</button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Global Settings */}
                                <div>
                                    <label className="block text-sm text-slate-300 mb-2">照片持續時間: {settings.photoDuration}s</label>
                                    <input 
                                        type="range" min="1" max="10" step="0.5" 
                                        value={settings.photoDuration}
                                        onChange={(e) => setSettings({...settings, photoDuration: parseFloat(e.target.value)})}
                                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-slate-300 mb-2">過場速度: {settings.transitionDuration}s</label>
                                    <input 
                                        type="range" min="0.1" max="2" step="0.1" 
                                        value={settings.transitionDuration}
                                        onChange={(e) => setSettings({...settings, transitionDuration: parseFloat(e.target.value)})}
                                        className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                    />
                                </div>
                                
                                <div>
                                    <label className="block text-sm text-slate-300 mb-2">批次設定過場效果</label>
                                    <select 
                                        onChange={(e) => handleBatchUpdateTransition(e.target.value)}
                                        className="w-full bg-slate-900 border border-slate-600 rounded p-2 text-sm text-white"
                                    >
                                        <option value="">選擇效果...</option>
                                        <option value="RANDOM_ALL">🎲 隨機分配全部</option>
                                        {Object.entries(transitionLabels).map(([val, label]) => (
                                            <option key={val} value={val}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                                
                                <button onClick={handleBackToCollage} className="w-full py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-lg transition mt-2">
                                    返回拼貼製作
                                </button>
                            </div>
                        )}
                        
                        {/* 4. Action Buttons */}
                        <div className="mt-6 flex flex-col gap-3">
                           {appState === AppState.EDITING && (
                             <button onClick={handleRender} className="w-full py-4 bg-gradient-to-r from-green-600 to-teal-600 text-white font-bold rounded-xl shadow-lg hover:shadow-green-500/30 hover:-translate-y-1 transition text-lg flex items-center justify-center gap-2">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                產生最終影片
                             </button>
                           )}
                           
                           {appState === AppState.FINISHED && videoUrl && (
                               <a 
                                 href={videoUrl} 
                                 download={`memory-reel${videoExtension}`}
                                 className="w-full py-4 bg-blue-600 text-white font-bold rounded-xl shadow-lg hover:bg-blue-500 transition text-center flex items-center justify-center gap-2"
                               >
                                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                  下載影片 ({videoExtension})
                               </a>
                           )}
                        </div>
                    </div>
                </div>

                {/* Right Column: Timeline & Preview */}
                <div className="lg:col-span-8 xl:col-span-9 lg:h-full flex flex-col bg-slate-950 overflow-hidden">
                    {/* Preview Area */}
                    <div className="flex-1 relative flex items-center justify-center p-4 bg-black/50 overflow-hidden">
                        <VideoPreview 
                            mediaList={media}
                            audio={audioTracks}
                            settings={settings}
                            appState={appState}
                            onRenderingComplete={handleRenderingComplete}
                            forcedIndex={previewIndex}
                            selectedMediaId={selectedMediaId}
                            onMediaUpdate={handleMediaUpdate}
                        />
                    </div>
                    
                    {/* Timeline Area */}
                    <div className="h-48 bg-slate-900 border-t border-slate-800 flex flex-col shrink-0">
                         <div className="px-4 py-2 flex justify-between items-center border-b border-slate-800 bg-slate-900">
                             <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Timeline Sequence</span>
                             <span className="text-xs text-slate-500">{media.length} items</span>
                         </div>
                         <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 flex items-center gap-2 scrollbar-thin">
                             {media.length === 0 ? (
                                 <div className="text-slate-500 text-sm italic w-full text-center">尚未加入任何素材</div>
                             ) : (
                                 media.map((item, index) => (
                                     <div 
                                        key={item.id}
                                        draggable
                                        onDragStart={(e) => handleDragStart(e, index)}
                                        onDragOver={(e) => handleDragOver(e, index)}
                                        onDragEnd={handleDragEnd}
                                        onClick={() => handleSelectMedia(item.id, index)}
                                        className={`relative group shrink-0 h-28 aspect-[4/3] rounded-lg overflow-hidden border-2 cursor-pointer transition-all transform hover:scale-105
                                            ${selectedMediaId === item.id ? 'border-blue-500 ring-2 ring-blue-500/50 scale-105 z-10' : 'border-slate-700 opacity-80 hover:opacity-100'}
                                            ${item.missing ? 'border-red-500 opacity-50' : ''}
                                        `}
                                     >
                                        <img src={item.previewUrl} className="w-full h-full object-cover bg-slate-800" alt="timeline" />
                                        
                                        {/* Type Badge */}
                                        <div className="absolute top-1 left-1 bg-black/60 backdrop-blur-sm text-[10px] px-1.5 rounded text-white font-bold">
                                            {item.type === 'video' ? 'VIDEO' : 'IMG'}
                                        </div>
                                        
                                        {/* Index Badge */}
                                        <div className="absolute bottom-1 left-1 bg-black/60 text-[10px] w-5 h-5 flex items-center justify-center rounded-full text-white">
                                            {index + 1}
                                        </div>

                                        {/* Context Actions (Hover) */}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                            <button 
                                                onClick={(e) => { e.stopPropagation(); removeMedia(index); }}
                                                className="p-1.5 bg-red-600/80 rounded-full hover:bg-red-600 text-white"
                                                title="移除"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                            </button>
                                            {item.type === 'video' && (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); toggleVideoAudio(index); }}
                                                    className={`p-1.5 rounded-full text-white ${item.enableOriginalAudio ? 'bg-blue-600/80' : 'bg-slate-600/80'}`}
                                                    title={item.enableOriginalAudio ? "原音開啟" : "原音靜音"}
                                                >
                                                    {item.enableOriginalAudio ? (
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                                                    ) : (
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                     </div>
                                 ))
                             )}
                         </div>
                    </div>
                </div>
            </div>
          )}
      </main>
    </div>
  );
};

export default App;