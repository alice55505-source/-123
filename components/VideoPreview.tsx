import React, { useRef, useEffect, useState, useCallback } from 'react';
import { UploadedMedia, VideoSettings, TransitionType, AudioTrack, AppState, CanvasItem, CollageData } from '../types';
import { GRADIENTS } from './CollageGenerator';

interface VideoPreviewProps {
  mediaList: UploadedMedia[];
  audio: AudioTrack[]; // Changed to Array
  settings: VideoSettings;
  appState: AppState;
  onRenderingComplete: (videoUrl: string, extension: string) => void;
  // New props for editing
  forcedIndex?: number;
  selectedMediaId?: string | null;
  onMediaUpdate?: (id: string, updates: Partial<UploadedMedia>) => void;
}

const VideoPreview: React.FC<VideoPreviewProps> = ({
  mediaList,
  audio,
  settings,
  appState,
  onRenderingComplete,
  forcedIndex,
  selectedMediaId,
  onMediaUpdate
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [manualSeekTime, setManualSeekTime] = useState<number | null>(null);
  
  // Interaction State for Dragging
  const [interactionMode, setInteractionMode] = useState<'NONE' | 'MOVE' | 'ROTATE' | 'RESIZE'>('NONE');
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [initialOverlayState, setInitialOverlayState] = useState<any>(null);

  // Refs for rendering loop
  const requestRef = useRef<number>();
  const startTimeRef = useRef<number>(0);
  const totalLoopDurationRef = useRef<number>(0);
  
  // Resources
  const imagesRef = useRef<(HTMLImageElement | HTMLVideoElement | null)[]>([]);
  // Cache for individual collage assets
  const collageAssetsRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  
  // Audio Context
  const audioContextRef = useRef<AudioContext | null>(null);
  // Store multiple audio buffers
  const audioBuffersRef = useRef<(AudioBuffer | null)[]>([]);
  const sourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const gainNodesRef = useRef<GainNode[]>([]);
  const videoSourceNodesRef = useRef<Map<HTMLVideoElement, MediaElementAudioSourceNode>>(new Map());
  const destNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // Load Resources (Images & Video Elements & Collage Assets)
  useEffect(() => {
    const loadResources = async () => {
      // Pause any existing videos
      imagesRef.current.forEach(item => {
        if (item instanceof HTMLVideoElement) item.pause();
      });

      // 1. Load Main Media Preview Assets (Legacy way, still needed for non-collage or fallback)
      const loadedMedia = await Promise.all(
        mediaList.map((m) => {
          return new Promise<HTMLImageElement | HTMLVideoElement | null>((resolve, reject) => {
            if (m.missing) {
                resolve(null); // Resolve null for missing files
                return;
            }

            if (m.type === 'video') {
              const vid = document.createElement('video');
              vid.src = m.previewUrl;
              vid.crossOrigin = "anonymous";
              // Do NOT mute by default, we control volume logic in drawLoop
              vid.muted = false; 
              vid.volume = 0; // Start at 0 to prevent noise
              vid.playsInline = true;
              vid.onloadeddata = () => resolve(vid);
              vid.onerror = (e) => { console.error("Video load error", e); resolve(null); }; // Handle error gracefully
              vid.load();
            } else {
              const image = new Image();
              image.src = m.previewUrl;
              image.onload = () => resolve(image);
              image.onerror = (e) => { console.error("Image load error", e); resolve(null); };
            }
          });
        })
      );
      imagesRef.current = loadedMedia;
      
      // 2. Load Collage Assets (Individual images inside collages)
      const assetPromises: Promise<void>[] = [];
      mediaList.forEach(m => {
          if (m.collageData) {
              m.collageData.items.forEach(item => {
                  if (item.type === 'image' && item.sourceUrl && !collageAssetsRef.current.has(item.sourceUrl)) {
                      const p = new Promise<void>((resolve) => {
                          const img = new Image();
                          img.src = item.sourceUrl!;
                          img.crossOrigin = "anonymous";
                          img.onload = () => {
                              collageAssetsRef.current.set(item.sourceUrl!, img);
                              resolve();
                          };
                          img.onerror = () => resolve();
                      });
                      assetPromises.push(p);
                  }
              });
          }
      });
      await Promise.all(assetPromises);

      // Reset video sources cache as elements changed
      videoSourceNodesRef.current.clear();
      
      // If we are editing, redraw immediate to show changes
      if (!isPlaying) {
          drawFrame(performance.now());
      }
    };
    if (mediaList.length > 0) {
      loadResources();
    } else {
        imagesRef.current = [];
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaList]);

  // Load Audio Buffers (Multiple)
  useEffect(() => {
    const loadAudio = async () => {
      if (audio.length === 0) {
        audioBuffersRef.current = [];
        return;
      }
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        const decodedBuffers = await Promise.all(
            audio.map(async (track) => {
                if (track.missing) return null;
                try {
                    const response = await fetch(track.url);
                    const arrayBuffer = await response.arrayBuffer();
                    return ctx.decodeAudioData(arrayBuffer);
                } catch (e) {
                    console.error("Audio load error", e);
                    return null;
                }
            })
        );
        
        audioBuffersRef.current = decodedBuffers;
        if (ctx.state !== 'closed') ctx.close(); // Close temp context safely
      } catch (e) {
        console.error("Failed to decode audio", e);
      }
    };
    loadAudio();
  }, [audio]);

  const calculateTotalDuration = () => {
    return mediaList.reduce((acc, item) => {
       const duration = item.type === 'video' ? (item.duration || 5) : settings.photoDuration;
       return acc + duration * 1000;
    }, 0);
  };

  // Jump to slide when requested
  useEffect(() => {
      if (forcedIndex !== undefined && forcedIndex !== null && mediaList.length > 0) {
          stopPlayback();
          let time = 0;
          for (let i = 0; i < forcedIndex; i++) {
              time += (mediaList[i].type === 'video' ? (mediaList[i].duration || 5) : settings.photoDuration) * 1000;
          }
          setManualSeekTime(time + 100);
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcedIndex]);

  // If paused, re-render when dependencies change (like text updates)
  useEffect(() => {
      if (!isPlaying) {
          if (requestRef.current) cancelAnimationFrame(requestRef.current);
          requestRef.current = requestAnimationFrame(() => drawFrame(performance.now()));
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaList, settings, manualSeekTime, selectedOverlayId]); // Added selectedOverlayId deps


  const drawFrame = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas || imagesRef.current.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!startTimeRef.current) startTimeRef.current = timestamp;
    const totalDuration = calculateTotalDuration();

    let loopTime = 0;
    if (appState === AppState.RENDERING) {
        const elapsed = timestamp - startTimeRef.current;
        if (elapsed >= totalLoopDurationRef.current) {
            stopRendering();
            return;
        }
        loopTime = Math.min(elapsed, totalDuration - 1);
    } else if (isPlaying) {
        const elapsed = timestamp - startTimeRef.current;
        loopTime = elapsed % totalDuration;
    } else {
        loopTime = manualSeekTime !== null ? manualSeekTime : 0;
    }
    
    // Find current slide and local time
    let currentSlideStart = 0;
    let slideIndex = 0;
    let slideDuration = 0;

    for (let i = 0; i < mediaList.length; i++) {
        const d = (mediaList[i].type === 'video' ? (mediaList[i].duration || 5) : settings.photoDuration) * 1000;
        if (loopTime >= currentSlideStart && loopTime < currentSlideStart + d) {
            slideIndex = i;
            slideDuration = d;
            break;
        }
        currentSlideStart += d;
    }

    const nextSlideIndex = (slideIndex + 1) % mediaList.length;
    const timeInSlide = loopTime - currentSlideStart;
    
    const transitionDurationMs = settings.transitionDuration * 1000;
    const effectiveTransitionDuration = Math.min(transitionDurationMs, slideDuration);
    
    // Ensure background cleared for transitions with transparency
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const mediaCurrent = imagesRef.current[slideIndex];
    const mediaNext = imagesRef.current[nextSlideIndex];
    const currentMediaData = mediaList[slideIndex];
    const nextMediaData = mediaList[nextSlideIndex];
    
    const renderPlaceholder = (missingName: string, alpha: number) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`檔案遺失: ${missingName}`, canvas.width/2, canvas.height/2);
        ctx.font = '16px sans-serif';
        ctx.fillText(`請重新上傳原始檔案以修復`, canvas.width/2, canvas.height/2 + 30);
        ctx.restore();
    };

    if (mediaCurrent && mediaCurrent instanceof HTMLVideoElement) {
        const vidTime = timeInSlide / 1000;
        if (Math.abs(mediaCurrent.currentTime - vidTime) > 0.3) {
            mediaCurrent.currentTime = vidTime;
        }
        
        if (appState === AppState.EDITING || appState === AppState.COLLAGE) {
            if (currentMediaData.enableOriginalAudio && isPlaying) {
                mediaCurrent.muted = false;
                mediaCurrent.volume = 1.0;
            } else {
                mediaCurrent.volume = 0;
            }
        } else {
            if (currentMediaData.enableOriginalAudio) {
                 mediaCurrent.volume = 1.0;
            } else {
                 mediaCurrent.volume = 0;
            }
        }

        if (isPlaying && mediaCurrent.paused) mediaCurrent.play().catch(() => {});
        if (!isPlaying && !mediaCurrent.paused) mediaCurrent.pause();
    } 
    
    imagesRef.current.forEach((m, idx) => {
        if (m && m instanceof HTMLVideoElement && idx !== slideIndex && !m.paused) {
            m.pause();
            m.volume = 0; 
        }
    });

    // USE PER-SLIDE TRANSITION
    // We use the current slide's transition setting to determine how it transitions TO the next one.
    // Default to FADE if missing.
    const transitionType = currentMediaData.transition || TransitionType.FADE;

    // --- Helper to draw effects (Stickers) ---
    const drawEffect = (item: CanvasItem, timeSec: number) => {
        if (item.type !== 'effect' || !item.animationType) return;
        
        // UNLIMITED DURATION: Removed the 3s check

        ctx.save();
        // ROTATION LOGIC: Translate Center -> Rotate -> Scale -> Draw at -w/2,-h/2
        const cx = item.x + item.width * item.scale / 2;
        const cy = item.y + item.height * item.scale / 2;
        ctx.translate(cx, cy);
        ctx.rotate(item.rotation || 0);
        ctx.scale(item.scale, item.scale);
        // Move back to local top-left of the centered box
        ctx.translate(-item.width/2, -item.height/2);

        const w = item.width;
        const h = item.height;
        const t = timeSec;
        
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // --- Aesthetic Linear Sticker Drawing Logic ---
        // Shared with CollageGenerator
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 2;

        switch (item.animationType) {
            case 'REC_FRAME':
                    const cornerLen = Math.min(w, h) * 0.2;
                    // Top-Left
                    ctx.beginPath(); ctx.moveTo(0, cornerLen); ctx.lineTo(0,0); ctx.lineTo(cornerLen, 0); ctx.stroke();
                    // Top-Right
                    ctx.beginPath(); ctx.moveTo(w-cornerLen, 0); ctx.lineTo(w,0); ctx.lineTo(w, cornerLen); ctx.stroke();
                    // Bottom-Left
                    ctx.beginPath(); ctx.moveTo(0, h-cornerLen); ctx.lineTo(0,h); ctx.lineTo(cornerLen, h); ctx.stroke();
                    // Bottom-Right
                    ctx.beginPath(); ctx.moveTo(w-cornerLen, h); ctx.lineTo(w,h); ctx.lineTo(w, h-cornerLen); ctx.stroke();
                    
                    // "REC" text
                    ctx.font = 'bold 20px sans-serif';
                    ctx.fillText("REC", 20, 30);
                    
                    // Blinking Red Dot
                    if (Math.floor(t * 2) % 2 === 0) {
                        ctx.fillStyle = '#ef4444'; // Red-500
                        ctx.beginPath();
                        ctx.arc(10, 23, 5, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    break;
                
                case 'RED_CIRCLE':
                    // Hand-drawn circle style
                    ctx.strokeStyle = '#ef4444'; // Red-500
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.save();
                    ctx.translate(w/2, h/2);
                    const circ = Math.PI * Math.max(w,h);
                    ctx.setLineDash([circ, circ]);
                    ctx.lineDashOffset = circ - (circ * Math.min(1, t)); // Draw in 1 second
                    
                    ctx.beginPath();
                    ctx.ellipse(0, 0, w/2 - 5, h/2 - 5, 0, 0, Math.PI * 2);
                    ctx.stroke();
                    
                    // Second pass slightly offset for marker look
                    ctx.globalAlpha = 0.6;
                    ctx.beginPath();
                    ctx.ellipse(1, 1, w/2 - 6, h/2 - 4, 0.1, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                    break;

                case 'LOCATION_PIN':
                     const pinW = Math.min(w, h) * 0.5;
                     const pinX = w/2;
                     const pinY = h - 10;
                     const bob = Math.sin(t * 5) * 5;
                     ctx.save();
                     ctx.translate(pinX, pinY - pinW - bob);
                     ctx.beginPath();
                     ctx.moveTo(0, pinW); 
                     ctx.bezierCurveTo(-pinW/2, pinW/2, -pinW, 0, -pinW, -pinW/4);
                     ctx.arc(0, -pinW/4, pinW, Math.PI, 0);
                     ctx.bezierCurveTo(pinW, 0, pinW/2, pinW/2, 0, pinW);
                     ctx.closePath();
                     ctx.stroke();
                     ctx.fillStyle = '#ffffff';
                     ctx.beginPath();
                     ctx.arc(0, -pinW/4, pinW/3, 0, Math.PI * 2);
                     ctx.fill();
                     ctx.restore();
                     ctx.save();
                     ctx.translate(pinX, pinY);
                     ctx.scale(1, 0.3);
                     ctx.fillStyle = 'rgba(0,0,0,0.3)';
                     ctx.beginPath();
                     ctx.arc(0, 0, 10 + Math.abs(bob), 0, Math.PI * 2);
                     ctx.fill();
                     ctx.restore();
                    break;

                case 'TAPE':
                    // Washi Tape Look
                    ctx.save();
                    ctx.globalAlpha = 0.6;
                    ctx.fillStyle = '#ffffff';
                    
                    // Main tape body
                    ctx.beginPath();
                    // Jagged edges
                    ctx.moveTo(0, 0);
                    for(let i=0; i<=w; i+=5) ctx.lineTo(i, Math.random()*2);
                    ctx.lineTo(w, h);
                    for(let i=w; i>=0; i-=5) ctx.lineTo(i, h - Math.random()*2);
                    ctx.lineTo(0, 0);
                    ctx.fill();
                    
                    // Grid Pattern
                    ctx.clip();
                    ctx.strokeStyle = '#cbd5e1'; // Slate-300
                    ctx.lineWidth = 1;
                    const gridSize = 10;
                    ctx.beginPath();
                    for(let x=0; x<w; x+=gridSize) { ctx.moveTo(x,0); ctx.lineTo(x,h); }
                    for(let y=0; y<h; y+=gridSize) { ctx.moveTo(0,y); ctx.lineTo(w,y); }
                    ctx.stroke();
                    ctx.restore();
                    break;

                case 'BULB_LINE':
                    const bulbW = Math.min(w,h) * 0.6;
                    const bX = w/2;
                    const bY = h/2;
                    
                    ctx.save();
                    ctx.translate(bX, bY);
                    
                    // Flicker opacity
                    const flicker = 0.8 + Math.sin(t * 20) * 0.2;
                    ctx.globalAlpha = flicker;
                    
                    ctx.beginPath();
                    // Bulb shape
                    ctx.arc(0, -bulbW/2, bulbW/2, Math.PI * 0.8, Math.PI * 2.2); // Circle part
                    ctx.quadraticCurveTo(bulbW/2, 0, bulbW/4, bulbW/2); // Neck right
                    ctx.lineTo(-bulbW/4, bulbW/2); // Base bottom line
                    ctx.quadraticCurveTo(-bulbW/2, 0, -bulbW*0.48, -bulbW*0.25); // Neck left
                    ctx.stroke();
                    
                    // Filament
                    ctx.beginPath();
                    ctx.moveTo(-10, 0);
                    ctx.lineTo(-5, -20);
                    ctx.lineTo(5, -20);
                    ctx.lineTo(10, 0);
                    ctx.stroke();
                    
                    // Glow lines
                    if (Math.sin(t*5) > 0) {
                        ctx.beginPath();
                        ctx.moveTo(0, -bulbW); ctx.lineTo(0, -bulbW - 10);
                        ctx.moveTo(bulbW, -bulbW/2); ctx.lineTo(bulbW+10, -bulbW/2 - 10);
                        ctx.moveTo(-bulbW, -bulbW/2); ctx.lineTo(-bulbW-10, -bulbW/2 - 10);
                        ctx.stroke();
                    }
                    
                    ctx.restore();
                    break;

                case 'HEART_LINE':
                    const heartScale = (Math.min(w,h) / 100);
                    // Heartbeat scale
                    const beat = 1 + Math.sin(t * 8) * 0.05;
                    
                    ctx.save();
                    ctx.translate(w/2, h/2);
                    ctx.scale(heartScale * beat, heartScale * beat);
                    
                    ctx.beginPath();
                    ctx.moveTo(0, 20);
                    ctx.bezierCurveTo(0, -10, -50, -10, -50, 20);
                    ctx.bezierCurveTo(-50, 50, 0, 80, 0, 90);
                    ctx.bezierCurveTo(0, 80, 50, 50, 50, 20);
                    ctx.bezierCurveTo(50, -10, 0, -10, 0, 20);
                    ctx.bezierCurveTo(50, -10, 0, -10, 0, 20);
                    ctx.stroke();
                    
                    ctx.restore();
                    break;
        }
        ctx.restore();

        // Draw selection UI for Effect
        if (selectedMediaId === currentMediaData.id && selectedOverlayId === item.id && !isPlaying && appState !== AppState.RENDERING) {
             const cx = item.x + item.width * item.scale / 2;
             const cy = item.y + item.height * item.scale / 2;

             ctx.save();
             ctx.translate(cx, cy);
             ctx.rotate(item.rotation || 0);
             ctx.scale(item.scale, item.scale);
             ctx.translate(-item.width/2, -item.height/2);

            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2 / item.scale;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(0, 0, item.width, item.height);
            
            // Handle
            const hSize = 10 / item.scale;
            ctx.fillStyle = '#3b82f6';
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(item.width, item.height, hSize, 0, Math.PI*2);
            ctx.fill();
            ctx.restore();
        }
    };

    // --- Helper to draw a Collage Slide ---
    // This allows us to animate stickers inside the collage during video export!
    const renderCollageFrame = (collage: CollageData, alpha: number, scale: number = 1, offsetX: number = 0, offsetY: number = 0, timeSec: number) => {
        const w = 960; // Base Collage Width
        const h = 720; // Base Collage Height
        
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        
        // Calculate destination rect
        const ratio = Math.min(canvas.width / w, canvas.height / h) * scale;
        const destW = w * ratio;
        const destH = h * ratio;
        const destX = (canvas.width - destW) / 2 + offsetX;
        const destY = (canvas.height - destH) / 2 + offsetY;
        
        ctx.translate(destX, destY);
        ctx.scale(ratio, ratio);
        
        // Clip to bounds
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();

        // 2. Draw Background
        const gradientDef = GRADIENTS.find(g => g.id === collage.bgGradientId) || GRADIENTS[0];
        const grd = ctx.createLinearGradient(0, 0, w, h);
        grd.addColorStop(0, gradientDef.colors[0]);
        grd.addColorStop(1, gradientDef.colors[1]);
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, w, h);

        // 3. Draw Items (Sorted by Z)
        const sorted = [...collage.items].sort((a,b) => a.zIndex - b.zIndex);
        
        sorted.forEach(item => {
            if (item.type === 'image' && item.sourceUrl) {
                const img = collageAssetsRef.current.get(item.sourceUrl);
                if (img) {
                    ctx.save();
                    // Basic image drawing doesn't support rotation inside collage in this specific block without full update
                    // But sticking to simple transforms for images for now
                    ctx.translate(item.x, item.y);
                    ctx.scale(item.scale, item.scale);
                    
                    // Shadow
                    ctx.shadowColor = 'rgba(0,0,0,0.3)';
                    ctx.shadowBlur = 10;
                    ctx.shadowOffsetX = 3;
                    ctx.shadowOffsetY = 3;

                    ctx.beginPath();
                    ctx.rect(0, 0, item.width, item.height);
                    ctx.clip();

                    const drawW = img.width * (item.imgBaseScale || 1) * (item.imgZoom || 1);
                    const drawH = img.height * (item.imgBaseScale || 1) * (item.imgZoom || 1);
                    const cX = (item.width - drawW) / 2;
                    const cY = (item.height - drawH) / 2;
                    const x = cX + (item.imgOffset?.x || 0);
                    const y = cY + (item.imgOffset?.y || 0);
                    
                    ctx.shadowColor = 'transparent';
                    ctx.drawImage(img, x, y, drawW, drawH);
                    ctx.restore();
                }
            } else if (item.type === 'text') {
                ctx.save();
                
                // Rotate Text
                const p = item.backgroundPadding || 0;
                const halfW = (item.width + p*2)/2;
                const halfH = (item.height + p*2)/2;
                const cx = item.x + halfW * item.scale;
                const cy = item.y + halfH * item.scale;
                
                ctx.translate(cx, cy);
                ctx.rotate(item.rotation || 0);
                ctx.scale(item.scale, item.scale);
                ctx.translate(-halfW, -halfH);
                
                if (p > 0) ctx.translate(p, p);

                ctx.font = `bold ${item.fontSize}px ${item.fontFamily}`;
                ctx.textBaseline = 'top';
                
                // Draw Background Box
                if (item.backgroundColor) {
                    const bgW = item.width + (p * 2);
                    const bgH = item.height + (p * 2);
                    const radius = item.backgroundRadius || 0;
                    const bAlpha = item.backgroundOpacity !== undefined ? item.backgroundOpacity : 0.8;
                    
                    ctx.save();
                    ctx.globalAlpha = bAlpha;
                    ctx.fillStyle = item.backgroundColor;
                    ctx.beginPath();
                    if (typeof ctx.roundRect === 'function') {
                        ctx.roundRect(-p, -p, bgW, bgH, radius);
                    } else {
                        ctx.rect(-p, -p, bgW, bgH);
                    }
                    ctx.fill();
                    ctx.restore();
                }

                ctx.shadowColor = 'rgba(0,0,0,0.2)';
                ctx.shadowBlur = 4;
                
                if (item.strokeWidth && item.strokeWidth > 0) {
                    ctx.strokeStyle = item.strokeColor || '#ffffff';
                    ctx.lineWidth = item.strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(item.text || '', 0, 0);
                }

                ctx.fillStyle = item.color || '#000';
                ctx.fillText(item.text || '', 0, 0);
                ctx.restore();
            } else if (item.type === 'effect') {
                // Animate sticker inside collage!
                // We use timeSec to drive animation.
                drawEffect(item, timeSec);
            }
        });

        ctx.restore();
    };

    const renderMedia = (media: HTMLImageElement | HTMLVideoElement | null, alpha: number, scale: number = 1, offsetX: number = 0, offsetY: number = 0, mediaData?: UploadedMedia) => {
        // PRIORITY: Check for Collage Data to render dynamically
        if (mediaData?.collageData) {
            renderCollageFrame(mediaData.collageData, alpha, scale, offsetX, offsetY, timeInSlide / 1000);
            return;
        }

        if (!media) {
            if (mediaData?.missing) {
                renderPlaceholder(mediaData.fileName || 'Unknown', alpha);
            }
            return;
        }
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        
        const mediaW = media instanceof HTMLVideoElement ? media.videoWidth : media.width;
        const mediaH = media instanceof HTMLVideoElement ? media.videoHeight : media.height;
        
        const ratio = Math.min(canvas.width / mediaW, canvas.height / mediaH) * scale;
        const w = mediaW * ratio;
        const h = mediaH * ratio;
        const x = (canvas.width - w) / 2 + offsetX;
        const y = (canvas.height - h) / 2 + offsetY;
        
        ctx.drawImage(media, x, y, w, h);
        ctx.restore();
    };

    // --- MAIN RENDER PIPELINE ---
    // Fix: Ensure we are calculating the transition window correctly
    const transitionStart = Math.max(0, slideDuration - effectiveTransitionDuration);
    
    // Zoom effect helper
    const getZoomScale = (type: TransitionType, progress0to1: number) => {
        if (type === TransitionType.ZOOM_IN) return 1.0 + (progress0to1 * 0.15); 
        if (type === TransitionType.ZOOM_OUT) return 1.15 - (progress0to1 * 0.15);
        return 1.0;
    };

    const slideLifeProgress = timeInSlide / slideDuration;
    const currentScale = getZoomScale(transitionType, slideLifeProgress);

    // If we are in the last frame of the video or just a single item, draw it without transition logic
    if (mediaList.length === 1 || (appState === AppState.RENDERING && slideIndex === mediaList.length - 1)) {
         renderMedia(mediaCurrent, 1, currentScale, 0, 0, currentMediaData);
    } else if (timeInSlide < transitionStart) {
        // Normal Playback Phase (No Transition yet)
        renderMedia(mediaCurrent, 1, currentScale, 0, 0, currentMediaData);
    } else {
        // Transition Phase
        const transProgress = (timeInSlide - transitionStart) / effectiveTransitionDuration;
        const t = Math.max(0, Math.min(1, transProgress));
        
        // IMPORTANT: The next slide might have a different transition setting, but for continuity
        // we usually control the *incoming* slide's appearance or the *outgoing* slide's disappearance based on the 
        // transition type of the boundary. Here we used `currentMediaData.transition` which implies "Transition Out".
        
        // For Zoom In/Out, we need to know what the next slide does? 
        // No, standard cross-fade logic usually applies "Next" scale based on its own entry, 
        // OR we just apply a standard scale for the incoming slide.
        // Let's use the 'current' transition type to define the whole effect pair.
        const nextScale = 1.0; // Simplify next slide scale during transition to avoid double-motion confusion
        
        switch (transitionType) {
            case TransitionType.SLIDE_LEFT:
                renderMedia(mediaCurrent, 1, currentScale, -t * canvas.width, 0, currentMediaData);
                renderMedia(mediaNext, 1, nextScale, (1 - t) * canvas.width, 0, nextMediaData);
                break;
            case TransitionType.SLIDE_RIGHT:
                renderMedia(mediaCurrent, 1, currentScale, t * canvas.width, 0, currentMediaData);
                renderMedia(mediaNext, 1, nextScale, -(1 - t) * canvas.width, 0, nextMediaData);
                break;
            case TransitionType.SLIDE_UP:
                renderMedia(mediaCurrent, 1, currentScale, 0, -t * canvas.height, currentMediaData);
                renderMedia(mediaNext, 1, nextScale, 0, (1 - t) * canvas.height, nextMediaData);
                break;
            case TransitionType.SLIDE_DOWN:
                renderMedia(mediaCurrent, 1, currentScale, 0, t * canvas.height, currentMediaData);
                renderMedia(mediaNext, 1, nextScale, 0, -(1 - t) * canvas.height, nextMediaData);
                break;
            case TransitionType.FADE:
            case TransitionType.ZOOM_IN:
            case TransitionType.ZOOM_OUT:
            default:
                // Draw Bottom (Current)
                renderMedia(mediaCurrent, 1, currentScale, 0, 0, currentMediaData); 
                // Draw next media on top with increasing alpha
                renderMedia(mediaNext, t, nextScale, 0, 0, nextMediaData); 
                break;
        }
    }

    // --- RENDER OVERLAYS (Effects & Text) for Current Slide ---
    // Only if NOT collage (since collage renders its own effects)
    if (!currentMediaData.collageData) {
        if (currentMediaData.overlayEffects) {
            currentMediaData.overlayEffects.forEach(effect => {
                drawEffect(effect, timeInSlide / 1000); 
            });
        }

        if (currentMediaData.overlayText) {
            const ot = currentMediaData.overlayText;
            ctx.save();
            
            // Rotation for Text Overlay
            const p = ot.backgroundPadding || 0;
            // Note: ot.width computed via measureText inside editor, might be missing here if just loaded
            ctx.font = `bold ${ot.fontSize}px ${ot.fontFamily}`;
            const metrics = ctx.measureText(ot.text || '');
            const measuredW = metrics.width;
            const measuredH = (ot.fontSize || 50) * 1.2;
            const finalW = ot.width || measuredW;
            
            const totalW = finalW + p*2;
            const totalH = measuredH + p*2;
            
            const boxW = totalW;
            const boxH = totalH;
            
            ctx.translate(ot.x + boxW/2, ot.y + boxH/2);
            ctx.rotate(ot.rotation || 0);
            ctx.translate(-boxW/2, -boxH/2);
            
            ctx.globalAlpha = 1; 
            ctx.textAlign = 'left'; // Reset to left because we draw rect at 0,0 relative to translated context
            ctx.textBaseline = 'top';
            
            // Draw BG
            if (ot.backgroundColor) {
                const radius = ot.backgroundRadius || 0;
                const alpha = ot.backgroundOpacity !== undefined ? ot.backgroundOpacity : 0.8;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = ot.backgroundColor;
                ctx.beginPath();
                if (typeof ctx.roundRect === 'function') {
                    ctx.roundRect(0, 0, boxW, boxH, radius);
                } else {
                    ctx.rect(0, 0, boxW, boxH);
                }
                ctx.fill();
                ctx.globalAlpha = 1; 
            }

            // Draw Text
            // Text starts at padding, padding
            const tx = p;
            const ty = p;

            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;

            if (ot.strokeWidth && ot.strokeWidth > 0) {
                ctx.lineWidth = ot.strokeWidth;
                ctx.strokeStyle = ot.strokeColor || '#000';
                ctx.lineJoin = 'round';
                ctx.strokeText(ot.text || '', tx, ty);
            }
            
            ctx.fillStyle = ot.color || '#fff';
            ctx.fillText(ot.text || '', tx, ty);

            ctx.restore();

            // Selection UI
            if (selectedMediaId === currentMediaData.id && selectedOverlayId === 'text' && !isPlaying && appState !== AppState.RENDERING) {
                 ctx.save();
                 ctx.translate(ot.x + boxW/2, ot.y + boxH/2);
                 ctx.rotate(ot.rotation || 0);
                 ctx.translate(-boxW/2, -boxH/2);

                 ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.shadowColor = 'transparent';
                 ctx.strokeRect(0, 0, boxW, boxH);
                 const handleSize = 10; ctx.fillStyle = '#3b82f6'; ctx.setLineDash([]); ctx.beginPath();
                 ctx.arc(boxW, boxH, handleSize, 0, Math.PI * 2); ctx.fill();
                 
                 // Rotation Handle
                 const rotDist = 25;
                 ctx.beginPath(); ctx.moveTo(boxW/2, 0); ctx.lineTo(boxW/2, -rotDist); ctx.stroke();
                 ctx.beginPath(); ctx.arc(boxW/2, -rotDist, handleSize, 0, Math.PI*2); ctx.fill();
                 
                 ctx.restore();
            }
        }
    }

    setCurrentMediaIndex(slideIndex);

    if (isPlaying || appState === AppState.RENDERING) {
      requestRef.current = requestAnimationFrame(drawFrame);
    }
  }, [isPlaying, appState, settings, mediaList, manualSeekTime, selectedOverlayId]); 

  // Audio setup 
  const setupAudioGraph = (ctx: AudioContext, destination: AudioNode) => {
      if (audioBuffersRef.current.length > 0) {
        const videoDuration = calculateTotalDuration() / 1000;
        
        const musicMixNode = ctx.createGain();
        const duckingGain = ctx.createGain();
        const masterGain = ctx.createGain();

        musicMixNode.connect(duckingGain);
        duckingGain.connect(masterGain);
        masterGain.connect(destination);
        
        // Standard Linear Loop / Sequence Logic
        let cursorTime = 0;
        let trackIndex = 0;
        const CROSSFADE_DURATION = 0.5;

        while (cursorTime < videoDuration) {
            const buffer = audioBuffersRef.current[trackIndex % audioBuffersRef.current.length];
            if (!buffer || buffer.duration < 0.1) {
                trackIndex++;
                if (trackIndex > 100) break;
                continue;
            }

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            
            const trackGain = ctx.createGain();
            source.connect(trackGain);
            trackGain.connect(musicMixNode);

            const startTime = cursorTime;
            const fadeTime = Math.min(CROSSFADE_DURATION, buffer.duration / 3);
            
            if (startTime > 0) {
                trackGain.gain.setValueAtTime(0, startTime);
                trackGain.gain.linearRampToValueAtTime(1, startTime + fadeTime);
            } else {
                trackGain.gain.setValueAtTime(1, 0);
            }

            const trackEndTime = startTime + buffer.duration;
            trackGain.gain.setValueAtTime(1, trackEndTime - fadeTime);
            trackGain.gain.linearRampToValueAtTime(0, trackEndTime);

            source.start(startTime);
            sourceNodesRef.current.push(source);
            gainNodesRef.current.push(trackGain);

            cursorTime += (buffer.duration - fadeTime); 
            trackIndex++;
        }

        // Apply Ducking Logic (Video sound overrides music)
        duckingGain.gain.setValueAtTime(1, 0);
        let currentTime = 0;
        mediaList.forEach(m => {
            const d = m.type === 'video' ? (m.duration || 5) : settings.photoDuration;
            if (m.type === 'video' && m.enableOriginalAudio && !m.missing) {
                const duckStart = Math.max(0, currentTime);
                const duckEnd = currentTime + d;
                duckingGain.gain.setValueAtTime(1, duckStart);
                duckingGain.gain.linearRampToValueAtTime(0.2, duckStart + 0.3);
                duckingGain.gain.setValueAtTime(0.2, duckEnd - 0.3);
                duckingGain.gain.linearRampToValueAtTime(1, duckEnd);
            }
            currentTime += d;
        });

        // Master Fade Out at very end of video
        const FADE_OUT_DURATION = 2.0;
        const fadeStart = Math.max(0, videoDuration - FADE_OUT_DURATION);
        masterGain.gain.setValueAtTime(1, 0); 
        masterGain.gain.setValueAtTime(1, fadeStart);
        masterGain.gain.linearRampToValueAtTime(0, videoDuration);

        gainNodesRef.current.push(musicMixNode);
        gainNodesRef.current.push(duckingGain);
        gainNodesRef.current.push(masterGain);
      }

      // Connect Video Element Audio (if rendering)
      if (appState === AppState.RENDERING) {
          mediaList.forEach((m, idx) => {
              if (m.type === 'video' && m.enableOriginalAudio && !m.missing) {
                  const el = imagesRef.current[idx];
                  if (el instanceof HTMLVideoElement) {
                      let vidSource = videoSourceNodesRef.current.get(el);
                      if (!vidSource) {
                          try {
                            vidSource = ctx.createMediaElementSource(el);
                            videoSourceNodesRef.current.set(el, vidSource);
                          } catch (err) {
                              console.warn("Could not create media source for video", err);
                          }
                      }
                      if (vidSource) {
                          vidSource.connect(destination);
                      }
                  }
              }
          });
      }
  };

  const startPlayback = async () => {
    setIsPlaying(true);
    setManualSeekTime(null);
    startTimeRef.current = performance.now();
    if (audioBuffersRef.current.length > 0 || mediaList.some(m => m.type === 'video')) {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioContextRef.current = ctx;
        setupAudioGraph(ctx, ctx.destination);
    }
    requestRef.current = requestAnimationFrame(drawFrame);
  };

  const stopPlayback = () => {
    setIsPlaying(false);
    if (startTimeRef.current && !manualSeekTime) {
         const elapsed = performance.now() - startTimeRef.current;
         setManualSeekTime(elapsed);
    }
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    sourceNodesRef.current.forEach(n => { try { n.stop(); } catch(e){} });
    sourceNodesRef.current = [];
    gainNodesRef.current = [];
    imagesRef.current.forEach(m => {
        if (m instanceof HTMLVideoElement) {
            m.pause();
            m.currentTime = 0;
        }
    });
  };

  const startRendering = async () => {
    if (!canvasRef.current) return;
    const stream = canvasRef.current.captureStream(30);
    canvasStreamRef.current = stream;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();
    destNodeRef.current = dest;
    setupAudioGraph(ctx, dest);

    const audioTracks = dest.stream.getAudioTracks();
    if (audioTracks.length > 0) {
        stream.addTrack(audioTracks[0]);
    }

    // Dynamic MIME type detection
    const getSupportedMimeType = () => {
        const types = [
            'video/mp4', // Safari preferred
            'video/webm;codecs=vp9', // Chrome High Quality
            'video/webm;codecs=vp8', // Chrome Compat
            'video/webm' // Generic
        ];
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return 'video/webm'; // Fallback
    };

    const mimeType = getSupportedMimeType();
    const options = { mimeType };
    
    // Determine extension based on selected mime type
    let extension = '.webm';
    if (mimeType.includes('mp4')) extension = '.mp4';
    else if (mimeType.includes('matroska')) extension = '.mkv';

    try {
        const recorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mimeType });
            const url = URL.createObjectURL(blob);
            onRenderingComplete(url, extension); // Pass extension back
            chunksRef.current = [];
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                audioContextRef.current.close();
            }
        };
        chunksRef.current = [];
        recorder.start(200); // 200ms timeslices for better stability
        startTimeRef.current = performance.now();
        totalLoopDurationRef.current = calculateTotalDuration();
        requestRef.current = requestAnimationFrame(drawFrame);
    } catch (e) {
        console.error("MediaRecorder error", e);
        alert("Video export not supported.");
    }
  };

  const stopRendering = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
      }
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      if (canvasStreamRef.current) {
          canvasStreamRef.current.getTracks().forEach(track => track.stop());
      }
      imagesRef.current.forEach(m => {
          if (m instanceof HTMLVideoElement) m.pause();
      });
  };

  useEffect(() => {
    if (appState === AppState.RENDERING) {
        startRendering();
    }
    return () => {
        if (appState !== AppState.RENDERING) {
             if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                stopRendering();
            }
        }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState]);

  // Mouse Handlers for Interactive Editing
  const getMousePos = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !canvasRef.current) return { x: 0, y: 0 };
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (appState === AppState.RENDERING || isPlaying || !canvasRef.current) return;
    const currentMedia = mediaList[currentMediaIndex];
    if (!currentMedia || currentMedia.id !== selectedMediaId) return;

    const pos = getMousePos(e);
    let hit = false;

    // 1. Check Effects (Top-most first)
    const effects = currentMedia.overlayEffects ? [...currentMedia.overlayEffects].reverse() : [];
    for (const effect of effects) {
        // ROTATION AWARE HIT TEST
        const cx = effect.x + effect.width * effect.scale / 2;
        const cy = effect.y + effect.height * effect.scale / 2;
        const angle = effect.rotation || 0;
        const dx = pos.x - cx;
        const dy = pos.y - cy;
        
        // Rotate mouse point back to check against unrotated box
        const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
        const localDy = dx * Math.sin(-angle) + dy * Math.cos(-angle);
        
        const halfW = (effect.width * effect.scale)/2;
        const halfH = (effect.height * effect.scale)/2;

        const hSize = 20;

        // Rotation Handle Check (Top Center in local space)
        const rotDist = 25;
        if (Math.hypot(localDx - 0, localDy - (-halfH - rotDist)) <= hSize) {
             setSelectedOverlayId(effect.id);
             setInteractionMode('ROTATE');
             setDragStartPos(pos);
             setInitialOverlayState({...effect, startRotation: effect.rotation || 0, startAngle: Math.atan2(pos.y - cy, pos.x - cx)});
             hit = true;
             break;
        }

        // Resize Handle (Bottom Right in local space)
        if (Math.hypot(localDx - halfW, localDy - halfH) <= hSize) {
             setSelectedOverlayId(effect.id);
             setInteractionMode('RESIZE');
             setDragStartPos(pos);
             setInitialOverlayState({...effect});
             hit = true;
             break;
        }
        
        // Body Hit (Unrotated Box check)
        if (Math.abs(localDx) <= halfW && Math.abs(localDy) <= halfH) {
             setSelectedOverlayId(effect.id);
             setInteractionMode('MOVE');
             setDragStartPos(pos);
             setInitialOverlayState({...effect});
             hit = true;
             break;
        }
    }

    // 2. Check Text (if no effect hit)
    if (!hit && currentMedia.overlayText) {
        const ot = currentMedia.overlayText;
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            ctx.save();
            ctx.font = `bold ${ot.fontSize}px ${ot.fontFamily}`;
            const metrics = ctx.measureText(ot.text || '');
            const p = ot.backgroundPadding || 0;
            const w = ot.backgroundColor ? (metrics.width + p*2) : (metrics.width + 20);
            const h = ot.backgroundColor ? ((ot.fontSize || 50)*1.2 + p*2) : ((ot.fontSize || 50) * 1.2);
            ctx.restore();
            
            const cx = ot.x + w/2; // ot.x is TopLeft in data
            const cy = ot.y + h/2;
            const angle = ot.rotation || 0;
            const dx = pos.x - cx;
            const dy = pos.y - cy;
            const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
            const localDy = dx * Math.sin(-angle) + dy * Math.cos(-angle);

            const halfW = w/2;
            const halfH = h/2;
            const hSize = 20;

             // Rotation Handle
            const rotDist = 25;
            if (Math.hypot(localDx - 0, localDy - (-halfH - rotDist)) <= hSize) {
                 setSelectedOverlayId('text');
                 setInteractionMode('ROTATE');
                 setDragStartPos(pos);
                 setInitialOverlayState({...ot, startRotation: ot.rotation || 0, startAngle: Math.atan2(pos.y - cy, pos.x - cx)});
                 hit = true;
            } else if (Math.hypot(localDx - halfW, localDy - halfH) <= hSize) {
                 setSelectedOverlayId('text');
                 setInteractionMode('RESIZE');
                 setDragStartPos(pos);
                 setInitialOverlayState({...ot});
                 hit = true;
            } else if (Math.abs(localDx) <= halfW && Math.abs(localDy) <= halfH) {
                 setSelectedOverlayId('text');
                 setInteractionMode('MOVE');
                 setDragStartPos(pos);
                 setInitialOverlayState({...ot});
                 hit = true;
            }
        }
    }

    if (!hit) {
        setSelectedOverlayId(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (interactionMode === 'NONE' || !selectedOverlayId || !initialOverlayState || !onMediaUpdate) return;
    const currentMedia = mediaList[currentMediaIndex];
    if (!currentMedia || currentMedia.id !== selectedMediaId) return;

    const pos = getMousePos(e);
    const dx = pos.x - dragStartPos.x;
    const dy = pos.y - dragStartPos.y;

    if (selectedOverlayId === 'text') {
        const ot = initialOverlayState;
        if (interactionMode === 'ROTATE') {
             // Calculate center again (approx based on initial state, ideally reuse logic)
             // Simplified: just assume we are rotating around the center derived from initial state
             const ctx = canvasRef.current?.getContext('2d');
             if(ctx) ctx.font = `bold ${ot.fontSize}px ${ot.fontFamily}`;
             const metrics = ctx?.measureText(ot.text || '').width || 100;
             const p = ot.backgroundPadding || 0;
             const w = ot.backgroundColor ? (metrics + p*2) : (metrics + 20);
             const h = ot.backgroundColor ? ((ot.fontSize || 50)*1.2 + p*2) : ((ot.fontSize || 50) * 1.2);
             
             const cx = ot.x + w/2;
             const cy = ot.y + h/2;
             
             const currentAngle = Math.atan2(pos.y - cy, pos.x - cx);
             const deltaAngle = currentAngle - ot.startAngle;
             
             onMediaUpdate(currentMedia.id, {
                overlayText: { ...ot, rotation: ot.startRotation + deltaAngle }
             });

        } else if (interactionMode === 'MOVE') {
            onMediaUpdate(currentMedia.id, {
                overlayText: { ...ot, x: ot.x + dx, y: ot.y + dy }
            });
        } else if (interactionMode === 'RESIZE') {
            const newSize = Math.max(10, (ot.fontSize || 60) + dy * 0.5);
            onMediaUpdate(currentMedia.id, {
                overlayText: { ...ot, fontSize: newSize }
            });
        }
    } else {
        const effects = currentMedia.overlayEffects || [];
        const idx = effects.findIndex(e => e.id === selectedOverlayId);
        if (idx === -1) return;
        
        const newEffects = [...effects];
        const newItem = { ...initialOverlayState };
        
        if (interactionMode === 'ROTATE') {
             const cx = newItem.x + newItem.width * newItem.scale / 2;
             const cy = newItem.y + newItem.height * newItem.scale / 2;
             const currentAngle = Math.atan2(pos.y - cy, pos.x - cx);
             const deltaAngle = currentAngle - newItem.startAngle;
             newItem.rotation = newItem.startRotation + deltaAngle;
        } else if (interactionMode === 'MOVE') {
            newItem.x = initialOverlayState.x + dx;
            newItem.y = initialOverlayState.y + dy;
        } else if (interactionMode === 'RESIZE') {
             // Simple resize logic: Use distance change rotated to local space? 
             // Or just use dy for scale
             const angle = newItem.rotation || 0;
             const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
             
             const newW = (initialOverlayState.width * initialOverlayState.scale) + localDx;
             const newScale = Math.max(0.1, newW / initialOverlayState.width);
             newItem.scale = newScale;
        }
        newEffects[idx] = newItem;
        onMediaUpdate(currentMedia.id, { overlayEffects: newEffects });
    }
  };

  const handleMouseUp = () => {
      setInteractionMode('NONE');
      setInitialOverlayState(null);
  };

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      <div className="relative rounded-lg overflow-hidden shadow-2xl border border-slate-700 bg-black">
        <canvas
            ref={canvasRef}
            width={settings.resolution.width}
            height={settings.resolution.height}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="w-full h-auto max-h-[60vh]"
            style={{ maxWidth: '100%', aspectRatio: `${settings.resolution.width}/${settings.resolution.height}`, cursor: interactionMode !== 'NONE' ? 'move' : 'default' }}
        />
        {appState === AppState.EDITING && (
            <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent flex justify-center items-center gap-4 transition-opacity opacity-0 hover:opacity-100">
                <button
                    onClick={isPlaying ? stopPlayback : startPlayback}
                    className="bg-white text-black p-3 rounded-full hover:bg-gray-200 transition"
                >
                    {isPlaying ? (
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
                    ) : (
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    )}
                </button>
            </div>
        )}
        {appState === AppState.RENDERING && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white z-50">
                <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500 mb-4"></div>
                <p className="text-xl font-semibold animate-pulse">正在渲染影片...</p>
                <p className="text-sm text-gray-300">請稍候...</p>
            </div>
        )}
      </div>
      {appState === AppState.EDITING && (
          <p className="text-slate-400 text-sm">
            第 {currentMediaIndex + 1} / {mediaList.length} (總長度: {(calculateTotalDuration() / 1000).toFixed(0)}s)
            {selectedOverlayId && <span className="text-blue-400 ml-2"> (編輯物件中)</span>}
          </p>
      )}
    </div>
  );
};

export default VideoPreview;