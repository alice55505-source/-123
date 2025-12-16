import React, { useEffect, useRef, useState, useCallback } from 'react';
import { UploadedMedia, CanvasItem, CollageData } from '../types';

interface CollageGeneratorProps {
  media: UploadedMedia[]; // Raw media
  createdCollages: UploadedMedia[]; // Previously created collages
  title: string; // Initial title
  onTitleChange: (t: string) => void;
  usedMediaIds: Set<string>; 
  onSave: (blob: Blob, usedIds: string[], collageData: CollageData, existingId?: string) => Promise<void>; 
  onFinish: () => void; 
}

// Extended Fonts List
export const FONTS = [
  { name: '童童體 (Cute)', value: '"Zen Maru Gothic", sans-serif' },
  { name: '圓體 (Round)', value: '"jf-openhuninn", "Huninn", sans-serif' },
  { name: '手寫體 (Handwriting)', value: '"LXGW Marker Gothic", sans-serif' },
  { name: '黑體 (Sans)', value: '"Noto Sans TC", sans-serif' },
  { name: '明體 (Serif)', value: '"Noto Serif TC", serif' },
  { name: '標楷體 (Calligraphy)', value: 'DFKai-SB, BiauKai, serif' },
  { name: 'Impact (English)', value: 'Impact, sans-serif' },
];

// Gradient Presets
export const GRADIENTS = [
  { id: 'red', name: '淡紅', colors: ['#fef2f2', '#fecaca'] },
  { id: 'orange', name: '淡橘', colors: ['#fff7ed', '#fed7aa'] },
  { id: 'yellow', name: '淡黃', colors: ['#fefce8', '#fef08a'] },
  { id: 'green', name: '淡綠', colors: ['#f0fdf4', '#bbf7d0'] },
  { id: 'blue', name: '淡藍', colors: ['#eff6ff', '#bfdbfe'] },
  { id: 'purple', name: '淡紫', colors: ['#faf5ff', '#e9d5ff'] },
  { id: 'dark', name: '深色', colors: ['#1e293b', '#0f172a'] },
];

export const EFFECTS_LIST = [
    { id: 'REC_FRAME', name: '🎥 錄影框' },
    { id: 'RED_CIRCLE', name: '🔴 重點圈' },
    { id: 'LOCATION_PIN', name: '📍 定位' },
    { id: 'TAPE', name: '🩹 紙膠帶' },
    { id: 'BULB_LINE', name: '💡 燈泡(線)' },
    { id: 'HEART_LINE', name: '♡ 愛心(線)' },
];

// Internal state needs the Image Element for rendering, which isn't in JSON
interface RenderCanvasItem extends CanvasItem {
  imgElement?: HTMLImageElement;
}

const CollageGenerator: React.FC<CollageGeneratorProps> = ({ 
  media, 
  createdCollages,
  title, 
  onTitleChange, 
  usedMediaIds, 
  onSave, 
  onFinish 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();
  const [loadedImages, setLoadedImages] = useState<{ id: string, img: HTMLImageElement }[]>([]);
  
  // State
  const [editingCollageId, setEditingCollageId] = useState<string | null>(null);
  const [bgGradientId, setBgGradientId] = useState<string>('blue');
  const [canvasItems, setCanvasItems] = useState<RenderCanvasItem[]>([]);
  
  // Ref for Items to avoid loop breaking
  const itemsRef = useRef<RenderCanvasItem[]>([]);
  useEffect(() => { itemsRef.current = canvasItems; }, [canvasItems]);

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  
  // Interaction State
  const [interactionMode, setInteractionMode] = useState<'NONE' | 'MOVE' | 'ROTATE' | 'RESIZE' | 'CROP_PAN' | 'CROP_TL' | 'CROP_TR' | 'CROP_BL' | 'CROP_BR'>('NONE');
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [initialItemState, setInitialItemState] = useState<any>(null);

  // Constants
  const WIDTH = 960;
  const HEIGHT = 720;
  const HANDLE_SIZE = 12;

  // 1. Load Raw Images for selection
  useEffect(() => {
    const loadImages = async () => {
      const imageFiles = media.filter(m => m.type === 'image');
      const loaded = await Promise.all(
        imageFiles.map(m => {
          return new Promise<{ id: string, img: HTMLImageElement }>((resolve) => {
            const img = new Image();
            img.src = m.previewUrl;
            img.onload = () => resolve({ id: m.id, img });
          });
        })
      );
      setLoadedImages(loaded);
    };
    loadImages();
  }, [media]);

  // 2. Initialize Title if empty
  useEffect(() => {
    if (canvasItems.length === 0 && !editingCollageId) {
        resetCanvas();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetCanvas = () => {
      setEditingCollageId(null);
      setBgGradientId('blue');
      onTitleChange("My Memories");
      setCanvasItems([{
        id: 'title',
        type: 'text',
        text: "My Memories",
        x: WIDTH * 0.5,
        y: HEIGHT * 0.1,
        width: 0,
        height: 0,
        scale: 1,
        rotation: 0,
        zIndex: 1000,
        fontFamily: FONTS[0].value,
        fontSize: 60,
        color: '#334155',
        strokeColor: '#ffffff',
        strokeWidth: 0,
        imgOffset: {x:0, y:0},
        imgZoom: 1,
        animationType: 'NONE'
      }]);
  };

  // Helper: Load a previous collage
  const loadCollage = async (collage: UploadedMedia) => {
      if (!collage.collageData) return;
      
      setEditingCollageId(collage.id);
      setBgGradientId(collage.collageData.bgGradientId);
      onTitleChange(collage.collageData.title);

      // Rehydrate items with image elements
      const hydratedItems = await Promise.all(collage.collageData.items.map(async (item) => {
          if (item.type === 'image') {
              // Priority 1: Find in media library (rawMedia)
              const originalMedia = media.find(m => m.id === item.id);
              // Priority 2: Use stored sourceUrl (for stickers or missing media)
              const src = originalMedia?.previewUrl || item.sourceUrl;
              
              if (src) {
                  const img = new Image();
                  img.src = src;
                  img.crossOrigin = "anonymous";
                  await new Promise((r, j) => {
                      img.onload = r;
                      img.onerror = r; // Proceed even if fail
                  });
                  return { ...item, imgElement: img, sourceUrl: src };
              }
          }
          return { ...item };
      }));
      setCanvasItems(hydratedItems);
      setSelectedItemId(null);
      setIsCropping(false);
  };

  // Toggle Image on Canvas
  const toggleImageOnCanvas = (id: string, imgObj: HTMLImageElement) => {
      setCanvasItems(prev => {
          const exists = prev.find(i => i.id === id);
          if (exists) {
              if (selectedItemId === id) {
                  setSelectedItemId(null);
                  setIsCropping(false);
              }
              return prev.filter(i => i.id !== id);
          } else {
              // Calculate initial scale to fit nicely (e.g., max 300px side)
              const targetSize = 300;
              const scale = Math.min(targetSize / imgObj.width, targetSize / imgObj.height);
              
              const w = imgObj.width * scale;
              const h = imgObj.height * scale;

              const newItem: RenderCanvasItem = {
                  id,
                  type: 'image',
                  imgElement: imgObj,
                  sourceUrl: imgObj.src,
                  x: Math.random() * (WIDTH - w),
                  y: Math.random() * (HEIGHT - h),
                  width: w,
                  height: h,
                  scale: 1, // Item global scale
                  rotation: 0,
                  zIndex: prev.length + 1,
                  imgOffset: {x: 0, y: 0},
                  imgZoom: 1,
                  imgBaseScale: scale, // IMPORTANT: Store the base scale to decouple image size from frame size
                  animationType: 'NONE'
              };
              setSelectedItemId(id);
              setIsCropping(false);
              return [...prev, newItem];
          }
      });
  };

  // Add Independent Effect Sticker
  const addEffectItem = (animId: string) => {
      const effectId = `effect-${Date.now()}`;
      // Default sizes for specific stickers
      let w = 200;
      let h = 200;
      
      if (animId === 'TAPE') { w = 200; h = 50; }
      if (animId === 'LOCATION_PIN') { w = 100; h = 100; }
      
      const newItem: RenderCanvasItem = {
          id: effectId,
          type: 'effect',
          x: WIDTH / 2 - w/2,
          y: HEIGHT / 2 - h/2,
          width: w,
          height: h,
          scale: 1,
          rotation: 0,
          zIndex: canvasItems.length + 10,
          animationType: animId as any
      };
      setCanvasItems(prev => [...prev, newItem]);
      setSelectedItemId(effectId);
      setIsCropping(false);
  };

  const updateSelectedItem = (updates: Partial<RenderCanvasItem>) => {
      if (!selectedItemId) return;
      setCanvasItems(prev => prev.map(i => i.id === selectedItemId ? { ...i, ...updates } : i));
  };

  // Animation Loop Logic
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background
    const gradientDef = GRADIENTS.find(g => g.id === bgGradientId) || GRADIENTS[0];
    const grd = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    grd.addColorStop(0, gradientDef.colors[0]);
    grd.addColorStop(1, gradientDef.colors[1]);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Sort & Draw (Use Ref to avoid closure staleness without dependency)
    // NOTE: Using itemsRef to prevent re-creating this loop on every item update, causing flicker
    const sortedItems = [...itemsRef.current].sort((a, b) => a.zIndex - b.zIndex);
    const now = Date.now();
    const t = (now / 1000) % 3; 

    // Main Draw Loop
    sortedItems.forEach(item => {
        ctx.save();
        
        const w = item.width;
        const h = item.height;
        let p = 0;
        if (item.type === 'text' && item.backgroundColor) {
            p = item.backgroundPadding || 0;
        }

        // Transform to Center -> Rotate -> Scale -> Move to TopLeft
        const halfW = (w + p*2) / 2;
        const halfH = (h + p*2) / 2;
        
        // Center position in World Space
        const cx = item.x + halfW * item.scale;
        const cy = item.y + halfH * item.scale;

        ctx.translate(cx, cy);
        ctx.rotate(item.rotation || 0);
        ctx.scale(item.scale, item.scale);
        // Move to Top-Left relative to center
        ctx.translate(-halfW, -halfH);
        
        if (p > 0) {
             ctx.translate(p, p);
        }

        if (item.type === 'image' && item.imgElement) {
            ctx.shadowColor = 'rgba(0,0,0,0.3)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetX = 3;
            ctx.shadowOffsetY = 3;

            // Crop/Masking Logic
            ctx.beginPath();
            ctx.rect(0, 0, w, h);
            ctx.clip();
            
            // Image drawing size is INDEPENDENT of frame width/height now
            const drawW = item.imgElement.width * (item.imgBaseScale || 1) * (item.imgZoom || 1);
            const drawH = item.imgElement.height * (item.imgBaseScale || 1) * (item.imgZoom || 1);

            // Center the image relative to the box center + offset
            const cX = (w - drawW) / 2;
            const cY = (h - drawH) / 2;
            const x = cX + (item.imgOffset?.x || 0);
            const y = cY + (item.imgOffset?.y || 0);
            
            ctx.shadowColor = 'transparent';
            ctx.drawImage(item.imgElement, x, y, drawW, drawH);

        } else if (item.type === 'text') {
            ctx.font = `bold ${item.fontSize}px ${item.fontFamily}`;
            ctx.textBaseline = 'top';
            
            // Handle multiline text measurement
            const lines = (item.text || '').split('\n');
            const lineHeight = (item.fontSize || 60) * 1.2;
            let maxWidth = 0;
            lines.forEach(line => {
                const metrics = ctx.measureText(line);
                if (metrics.width > maxWidth) maxWidth = metrics.width;
            });
            
            item.width = maxWidth;
            item.height = lineHeight * lines.length;

            // Draw Background Box
            if (item.backgroundColor) {
                // We are currently at (0,0) which is text origin.
                // Box should be drawn at -p, -p to w+p, h+p
                const bgW = item.width + (p * 2);
                const bgH = item.height + (p * 2);
                const radius = item.backgroundRadius || 0;
                const alpha = item.backgroundOpacity !== undefined ? item.backgroundOpacity : 0.8;
                
                ctx.save();
                ctx.globalAlpha = alpha;
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
            
            // Draw Text Lines
            lines.forEach((line, i) => {
                const ly = i * lineHeight;
                if (item.strokeWidth && item.strokeWidth > 0) {
                    ctx.strokeStyle = item.strokeColor || '#ffffff';
                    ctx.lineWidth = item.strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(line, 0, ly);
                }

                ctx.fillStyle = item.color || '#000';
                ctx.fillText(line, 0, ly);
            });
            
        } else if (item.type === 'effect') {
             // ... existing effect logic ...
             // Copied from previous but kept concise for xml
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
                    ctx.beginPath(); ctx.moveTo(0, cornerLen); ctx.lineTo(0,0); ctx.lineTo(cornerLen, 0); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(w-cornerLen, 0); ctx.lineTo(w,0); ctx.lineTo(w, cornerLen); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(0, h-cornerLen); ctx.lineTo(0,h); ctx.lineTo(cornerLen, h); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(w-cornerLen, h); ctx.lineTo(w,h); ctx.lineTo(w, h-cornerLen); ctx.stroke();
                    ctx.font = 'bold 20px sans-serif';
                    ctx.fillText("REC", 20, 30);
                    if (Math.floor(t * 2) % 2 === 0) {
                        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(10, 23, 5, 0, Math.PI * 2); ctx.fill();
                    }
                    break;
                case 'RED_CIRCLE':
                    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4; ctx.beginPath(); ctx.save(); ctx.translate(w/2, h/2);
                    const circ = Math.PI * Math.max(w,h); ctx.setLineDash([circ, circ]); ctx.lineDashOffset = circ - (circ * Math.min(1, t)); 
                    ctx.beginPath(); ctx.ellipse(0, 0, w/2 - 5, h/2 - 5, 0, 0, Math.PI * 2); ctx.stroke();
                    ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.ellipse(1, 1, w/2 - 6, h/2 - 4, 0.1, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
                    break;
                case 'LOCATION_PIN':
                     const pinW = Math.min(w, h) * 0.5; const pinX = w/2; const pinY = h - 10; const bob = Math.sin(t * 5) * 5;
                     ctx.save(); ctx.translate(pinX, pinY - pinW - bob); ctx.beginPath(); ctx.moveTo(0, pinW); 
                     ctx.bezierCurveTo(-pinW/2, pinW/2, -pinW, 0, -pinW, -pinW/4); ctx.arc(0, -pinW/4, pinW, Math.PI, 0);
                     ctx.bezierCurveTo(pinW, 0, pinW/2, pinW/2, 0, pinW); ctx.closePath(); ctx.stroke();
                     ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, -pinW/4, pinW/3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
                     ctx.save(); ctx.translate(pinX, pinY); ctx.scale(1, 0.3); ctx.fillStyle = 'rgba(0,0,0,0.3)';
                     ctx.beginPath(); ctx.arc(0, 0, 10 + Math.abs(bob), 0, Math.PI * 2); ctx.fill(); ctx.restore();
                    break;
                case 'TAPE':
                    ctx.save(); ctx.globalAlpha = 0.6; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, 0);
                    for(let i=0; i<=w; i+=5) ctx.lineTo(i, Math.random()*2); ctx.lineTo(w, h);
                    for(let i=w; i>=0; i-=5) ctx.lineTo(i, h - Math.random()*2); ctx.lineTo(0, 0); ctx.fill();
                    ctx.clip(); ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; const gridSize = 10; ctx.beginPath();
                    for(let x=0; x<w; x+=gridSize) { ctx.moveTo(x,0); ctx.lineTo(x,h); } for(let y=0; y<h; y+=gridSize) { ctx.moveTo(0,y); ctx.lineTo(w,y); }
                    ctx.stroke(); ctx.restore();
                    break;
                case 'BULB_LINE':
                    const bulbW = Math.min(w,h) * 0.6; const bX = w/2; const bY = h/2; ctx.save(); ctx.translate(bX, bY);
                    const flicker = 0.8 + Math.sin(t * 20) * 0.2; ctx.globalAlpha = flicker; ctx.beginPath();
                    ctx.arc(0, -bulbW/2, bulbW/2, Math.PI * 0.8, Math.PI * 2.2); ctx.quadraticCurveTo(bulbW/2, 0, bulbW/4, bulbW/2);
                    ctx.lineTo(-bulbW/4, bulbW/2); ctx.quadraticCurveTo(-bulbW/2, 0, -bulbW*0.48, -bulbW*0.25); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(-5, -20); ctx.lineTo(5, -20); ctx.lineTo(10, 0); ctx.stroke();
                    if (Math.sin(t*5) > 0) { ctx.beginPath(); ctx.moveTo(0, -bulbW); ctx.lineTo(0, -bulbW - 10); ctx.moveTo(bulbW, -bulbW/2); ctx.lineTo(bulbW+10, -bulbW/2 - 10); ctx.moveTo(-bulbW, -bulbW/2); ctx.lineTo(-bulbW-10, -bulbW/2 - 10); ctx.stroke(); }
                    ctx.restore();
                    break;
                case 'HEART_LINE':
                    const heartScale = (Math.min(w,h) / 100); const beat = 1 + Math.sin(t * 8) * 0.05; ctx.save(); ctx.translate(w/2, h/2);
                    ctx.scale(heartScale * beat, heartScale * beat); ctx.beginPath(); ctx.moveTo(0, 20);
                    ctx.bezierCurveTo(0, -10, -50, -10, -50, 20); ctx.bezierCurveTo(-50, 50, 0, 80, 0, 90); ctx.bezierCurveTo(0, 80, 50, 50, 50, 20);
                    ctx.bezierCurveTo(50, -10, 0, -10, 0, 20); ctx.bezierCurveTo(50, -10, 0, -10, 0, 20); ctx.stroke(); ctx.restore();
                    break;
            }
        }
        
        ctx.restore();
        
        // Draw Selection UI
        if (item.id === selectedItemId) {
            const halfW = (item.width + p*2)/2;
            const halfH = (item.height + p*2)/2;
            const cx = item.x + halfW * item.scale;
            const cy = item.y + halfH * item.scale;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(item.rotation || 0);
            ctx.translate(-halfW * item.scale, -halfH * item.scale);
            ctx.scale(item.scale, item.scale);
            
            if (isCropping && item.type === 'image') {
                ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2 / item.scale; ctx.setLineDash([5, 3]);
                ctx.strokeRect(0, 0, item.width, item.height);
                ctx.fillStyle = '#f59e0b'; const hSize = HANDLE_SIZE / item.scale;
                ctx.fillRect(-hSize/2, -hSize/2, hSize, hSize); ctx.fillRect(item.width - hSize/2, -hSize/2, hSize, hSize);
                ctx.fillRect(-hSize/2, item.height - hSize/2, hSize, hSize); ctx.fillRect(item.width - hSize/2, item.height - hSize/2, hSize, hSize);
            } else {
                const selW = item.width + (p * 2);
                const selH = item.height + (p * 2);
                ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2 / item.scale; ctx.strokeRect(0, 0, selW, selH);
                ctx.fillStyle = '#3b82f6'; const hSize = HANDLE_SIZE / item.scale;
                ctx.beginPath(); ctx.arc(selW, selH, hSize, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(selW, selH, hSize/2, 0, Math.PI * 2); ctx.fill();
                const rotHandleDist = 25 / item.scale;
                ctx.beginPath(); ctx.moveTo(selW/2, 0); ctx.lineTo(selW/2, -rotHandleDist); ctx.strokeStyle = '#3b82f6'; ctx.stroke();
                ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(selW/2, -rotHandleDist, hSize, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();
        }
    });

    requestRef.current = requestAnimationFrame(drawFrame);
  }, [bgGradientId, selectedItemId, isCropping]);

  // Start/Stop Loop
  useEffect(() => {
    requestRef.current = requestAnimationFrame(drawFrame);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [drawFrame]);

  // Mouse Handlers
  const getMousePos = (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const scaleX = WIDTH / rect.width;
      const scaleY = HEIGHT / rect.height;
      return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
      const pos = getMousePos(e);
      if (selectedItemId) {
          const item = canvasItems.find(i => i.id === selectedItemId);
          if (item) {
              const p = (item.type === 'text' ? (item.backgroundPadding || 0) : 0);
              const totalW = (item.width + p*2) * item.scale;
              const totalH = (item.height + p*2) * item.scale;
              const halfW = totalW / 2;
              const halfH = totalH / 2;
              const cx = item.x + halfW;
              const cy = item.y + halfH;
              
              const dx = pos.x - cx;
              const dy = pos.y - cy;
              const angle = item.rotation || 0;
              const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
              const localDy = dx * Math.sin(-angle) + dy * Math.cos(-angle);
              
              const localX = localDx + halfW;
              const localY = localDy + halfH;
              const hSize = HANDLE_SIZE * 1.5; 
              const rotHandleDist = 25;
              if (Math.hypot(localX - halfW, localY - (-rotHandleDist)) <= hSize) {
                  setInteractionMode('ROTATE'); setDragStartPos(pos); setInitialItemState({ ...item, startRotation: item.rotation || 0, startAngle: Math.atan2(pos.y - cy, pos.x - cx) }); return;
              }
              if (isCropping && item.type === 'image') {
                   if (Math.hypot(localX - 0, localY - 0) <= hSize) { setInteractionMode('CROP_TL'); setDragStartPos(pos); setInitialItemState({...item}); return; }
                   if (Math.hypot(localX - totalW, localY - 0) <= hSize) { setInteractionMode('CROP_TR'); setDragStartPos(pos); setInitialItemState({...item}); return; }
                   if (Math.hypot(localX - 0, localY - totalH) <= hSize) { setInteractionMode('CROP_BL'); setDragStartPos(pos); setInitialItemState({...item}); return; }
                   if (Math.hypot(localX - totalW, localY - totalH) <= hSize) { setInteractionMode('CROP_BR'); setDragStartPos(pos); setInitialItemState({...item}); return; }
                   if (localX >= 0 && localX <= totalW && localY >= 0 && localY <= totalH) { setInteractionMode('CROP_PAN'); setDragStartPos(pos); setInitialItemState({...item}); return; }
              } else {
                   if (Math.hypot(localX - totalW, localY - totalH) <= hSize) { setInteractionMode('RESIZE'); setDragStartPos(pos); setInitialItemState({ ...item }); return; }
              }
          }
      }

      const sorted = [...canvasItems].sort((a, b) => b.zIndex - a.zIndex);
      for (const item of sorted) {
            const p = (item.type === 'text' ? (item.backgroundPadding || 0) : 0);
            const totalW = (item.width + p*2) * item.scale;
            const totalH = (item.height + p*2) * item.scale;
            const halfW = totalW / 2;
            const halfH = totalH / 2;
            const cx = item.x + halfW;
            const cy = item.y + halfH;
            
            const dx = pos.x - cx;
            const dy = pos.y - cy;
            const angle = item.rotation || 0;
            const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
            const localDy = dx * Math.sin(-angle) + dy * Math.cos(-angle);
            
            if (Math.abs(localDx) <= halfW && Math.abs(localDy) <= halfH) {
                setSelectedItemId(item.id);
                if (selectedItemId !== item.id) setIsCropping(false);
                setInteractionMode('MOVE'); setDragStartPos(pos); setInitialItemState({ ...item });
                setCanvasItems(prev => { const maxZ = Math.max(...prev.map(i => i.zIndex)); return prev.map(i => i.id === item.id ? { ...i, zIndex: maxZ + 1 } : i); });
                return;
            }
      }
      setSelectedItemId(null); setIsCropping(false); setInteractionMode('NONE');
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (interactionMode === 'NONE' || !selectedItemId || !initialItemState) return;
      const pos = getMousePos(e);
      const dx = pos.x - dragStartPos.x;
      const dy = pos.y - dragStartPos.y;

      setCanvasItems(prev => prev.map(item => {
          if (item.id === selectedItemId) {
              if (interactionMode === 'ROTATE') {
                  const p = (item.type === 'text' ? (item.backgroundPadding || 0) : 0);
                  const totalW = (item.width + p*2) * item.scale;
                  const totalH = (item.height + p*2) * item.scale;
                  const cx = initialItemState.x + totalW/2;
                  const cy = initialItemState.y + totalH/2;
                  const currentAngle = Math.atan2(pos.y - cy, pos.x - cx);
                  const deltaAngle = currentAngle - initialItemState.startAngle;
                  return { ...item, rotation: (initialItemState.startRotation + deltaAngle) };
              }
              if (interactionMode === 'MOVE') return { ...item, x: initialItemState.x + dx, y: initialItemState.y + dy };
              if (interactionMode === 'RESIZE') {
                  const angle = item.rotation || 0;
                  const localDx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
                  const newW = (initialItemState.width * initialItemState.scale) + localDx;
                  const newScale = Math.max(0.1, newW / initialItemState.width);
                  return { ...item, scale: newScale };
              }
              if (interactionMode === 'CROP_BR') {
                  const dW = dx / item.scale; const dH = dy / item.scale;
                  return { ...item, width: Math.max(50, initialItemState.width + dW), height: Math.max(50, initialItemState.height + dH), imgOffset: { x: (initialItemState.imgOffset?.x || 0) - dW/2, y: (initialItemState.imgOffset?.y || 0) - dH/2 } };
              }
              if (interactionMode === 'CROP_PAN') {
                  const dOffsetX = dx / item.scale; const dOffsetY = dy / item.scale;
                  return { ...item, imgOffset: { x: (initialItemState.imgOffset?.x || 0) + dOffsetX, y: (initialItemState.imgOffset?.y || 0) + dOffsetY } };
              }
          }
          return item;
      }));
  };

  const handleMouseUp = () => { setInteractionMode('NONE'); setInitialItemState(null); };

  const handleSaveInternal = async (finish: boolean = false) => {
      setSelectedItemId(null); setIsCropping(false);
      setTimeout(() => {
          if (canvasRef.current) {
              canvasRef.current.toBlob(async (blob) => {
                  if (blob) {
                      const cleanItems: CanvasItem[] = canvasItems.map(({ imgElement, ...rest }) => rest);
                      const collageData: CollageData = { items: cleanItems, bgGradientId, title: canvasItems.find(i => i.id === 'title')?.text || title };
                      const usedIds = canvasItems.filter(i => i.type === 'image' && !i.isSticker).map(i => i.id);
                      await onSave(blob, usedIds, collageData, editingCollageId || undefined);
                      if (finish) { onFinish(); } else { resetCanvas(); }
                  }
              });
          }
      }, 50); 
  };

  const selectedItem = canvasItems.find(i => i.id === selectedItemId);

  return (
    <div className="lg:h-full w-full max-w-[1920px] mx-auto grid grid-cols-1 lg:grid-cols-12 gap-0 lg:overflow-hidden">
      
      {/* LEFT: Controls Panel (Scrollable) */}
      <div className="lg:col-span-4 xl:col-span-3 lg:h-full flex flex-col bg-slate-900 border-r border-slate-800">
          <div className="flex-1 lg:overflow-y-auto p-6 scrollbar-thin">
            
            {/* Created Collages List */}
            {createdCollages.length > 0 && (
                <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg shrink-0 mb-6">
                    <h3 className="text-sm font-bold text-white mb-2">已建立的拼貼</h3>
                    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
                        {createdCollages.map(c => (
                            <div key={c.id} onClick={() => loadCollage(c)} className={`relative min-w-[80px] w-20 aspect-square cursor-pointer rounded overflow-hidden border-2 ${editingCollageId === c.id ? 'border-blue-500 ring-2 ring-blue-500/50' : 'border-slate-600 hover:border-slate-400'}`}>
                                <img src={c.previewUrl} className="w-full h-full object-cover" alt="collage" />
                                {editingCollageId === c.id && <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center text-[10px] text-white font-bold">編輯中</div>}
                            </div>
                        ))}
                        <div onClick={resetCanvas} className={`min-w-[80px] w-20 aspect-square cursor-pointer rounded border-2 border-dashed border-slate-600 hover:border-slate-400 flex items-center justify-center text-slate-400 text-xs text-center ${!editingCollageId ? 'border-green-500 text-green-500' : ''}`}>+ 新增</div>
                    </div>
                </div>
            )}

            {/* 1. Photo Selector */}
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg shrink-0 mb-6">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-sm font-bold text-white">1. 選擇照片加入畫布</h3>
                </div>
                <div className="grid grid-cols-4 gap-2 max-h-[200px] overflow-y-auto p-1 scrollbar-thin">
                    {loadedImages.map(({ id, img }) => {
                        const isOnCanvas = canvasItems.some(i => i.id === id);
                        const isUsedElsewhere = usedMediaIds.has(id);
                        if (isUsedElsewhere && !isOnCanvas) return null;
                        return (
                            <div key={id} onClick={() => toggleImageOnCanvas(id, img)} className={`relative aspect-square cursor-pointer rounded overflow-hidden border-2 transition-all ${isOnCanvas ? 'border-green-500 ring-2 ring-green-500/50' : 'border-transparent opacity-80 hover:opacity-100'}`}>
                                <img src={img.src} alt="select" className="w-full h-full object-cover" />
                                {isOnCanvas && <div className="absolute top-0 right-0 bg-green-500 text-white p-0.5 rounded-bl shadow"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg></div>}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 2. Aesthetic Stickers (New) */}
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg shrink-0 mb-6">
                <h3 className="text-sm font-bold text-white mb-2">2. 加入動態裝飾 (可旋轉)</h3>
                <div className="grid grid-cols-3 gap-2">
                    {EFFECTS_LIST.map(eff => (
                        <button key={eff.id} onClick={() => addEffectItem(eff.id)} className="text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded p-2 text-center transition">{eff.name}</button>
                    ))}
                </div>
            </div>

            {/* 3. Global Styles */}
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-lg shrink-0 mb-6">
                <h3 className="text-sm font-bold text-white mb-3">3. 畫布設定</h3>
                <div className="mb-2">
                    <label className="text-xs font-bold text-slate-300 block mb-2">背景色系</label>
                    <div className="grid grid-cols-7 gap-2">
                        {GRADIENTS.map(g => (
                            <button key={g.id} onClick={() => { setBgGradientId(g.id); updateSelectedItem({ color: g.id !== 'dark' ? '#334155' : '#ffffff' }); }} title={g.name} className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${bgGradientId === g.id ? 'border-white scale-110 shadow-lg' : 'border-transparent'}`} style={{ background: `linear-gradient(135deg, ${g.colors[0]}, ${g.colors[1]})` }} />
                        ))}
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2 shrink-0 pb-4">
                <button onClick={() => handleSaveInternal(false)} className="w-full py-3 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg transition shadow-lg flex items-center justify-center gap-2">{editingCollageId ? '儲存變更' : '儲存並新增下一組'}</button>
                <button onClick={() => handleSaveInternal(true)} className="w-full py-2 bg-green-700 hover:bg-green-600 text-white font-medium rounded-lg transition">儲存完成並影片製作</button>
            </div>
            
            <div className="h-20"></div>
          </div>
      </div>

      {/* RIGHT: Preview Canvas Area (Fixed) */}
      <div className="lg:col-span-8 xl:col-span-9 lg:h-full flex justify-center items-center bg-slate-950 p-4 border-l border-slate-800 min-h-[50vh]">
         <div className="relative border border-slate-600 shadow-2xl overflow-hidden bg-black select-none max-h-full max-w-full aspect-[4/3]">
             <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} className="w-full h-full object-contain block" style={{ cursor: interactionMode === 'NONE' ? 'default' : 'move' }} />
            
            {/* Floating Editor Panel */}
            {selectedItem && (
                 <div className="absolute top-4 right-4 w-[280px] bg-slate-900/90 backdrop-blur-md border border-slate-600 rounded-xl p-4 shadow-2xl z-50 transition-all animate-fade-in" onClick={(e) => e.stopPropagation()}>
                     <div className="flex justify-between items-center mb-3 border-b border-slate-700 pb-2">
                        <label className="text-xs font-bold text-blue-300">
                            {selectedItem.type === 'effect' ? '特效物件設定' : selectedItem.type === 'image' ? '照片設定' : '文字設定'}
                        </label>
                        <div className="flex gap-2">
                             {selectedItem.type === 'image' && (
                                <button onClick={() => setIsCropping(!isCropping)} className={`text-[10px] px-2 py-0.5 rounded transition-colors ${isCropping ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                                    {isCropping ? '完成裁切' : '裁切照片'}
                                </button>
                             )}
                            <button onClick={() => { setCanvasItems(prev => prev.filter(i => i.id !== selectedItemId)); setSelectedItemId(null); }} className="text-red-400 hover:text-red-300 text-xs border border-red-900 bg-red-900/20 px-2 rounded">刪除</button>
                            <button onClick={() => setSelectedItemId(null)} className="text-slate-400 hover:text-white">✕</button>
                        </div>
                     </div>
                     
                     {selectedItem.type === 'effect' && (
                         <div className="text-xs text-slate-400 mb-2">
                             <p>這是獨立的動態裝飾。</p>
                             <p>拖曳藍點可縮放，上方圓點可旋轉。</p>
                         </div>
                     )}

                     {selectedItem.type === 'image' && isCropping && (
                        <div className="bg-slate-800 p-2 rounded mb-2 border border-slate-700">
                            <label className="block text-[10px] text-slate-400 mb-1">縮放內容 (Zoom)</label>
                            <input type="range" min="0.1" max="5" step="0.1" value={selectedItem.imgZoom || 1} onChange={(e) => updateSelectedItem({ imgZoom: parseFloat(e.target.value) })} className="w-full accent-amber-500 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer" />
                            <p className="text-[10px] text-slate-500 mt-2">💡 <b>裁切模式說明：</b><br/>1. 拖曳<b>橘色邊框</b>：改變可視範圍 (遮罩)。<br/>2. 拖曳<b>照片本身</b>：在框內移動照片位置。</p>
                        </div>
                     )}

                     {selectedItem.type === 'text' && (
                         <div className="space-y-3">
                             <textarea 
                                rows={2}
                                value={selectedItem.text || ''} 
                                onChange={(e) => { 
                                    const t = e.target.value;
                                    onTitleChange(t); 
                                    updateSelectedItem({ text: t }); 
                                }}
                                className="w-full bg-slate-800 border border-slate-600 rounded p-2 text-sm text-white resize-none"
                             />
                             <div className="flex gap-2">
                                <select value={selectedItem.fontFamily} onChange={(e) => updateSelectedItem({ fontFamily: e.target.value })} className="flex-1 bg-slate-800 border border-slate-600 rounded p-1 text-xs text-white">
                                    {FONTS.map(f => <option key={f.name} value={f.value}>{f.name}</option>)}
                                </select>
                                <input type="color" value={selectedItem.color} onChange={(e) => updateSelectedItem({ color: e.target.value })} className="w-8 h-6 rounded cursor-pointer border-none bg-transparent" />
                             </div>

                             {/* Text Outline Section */}
                             <div className="mt-2 pt-2 border-t border-slate-700">
                                 <div className="flex justify-between items-center mb-1">
                                    <label className="text-xs text-slate-400">文字外框</label>
                                    <input 
                                        type="color" 
                                        value={selectedItem.strokeColor || '#ffffff'}
                                        onChange={(e) => updateSelectedItem({ strokeColor: e.target.value, strokeWidth: selectedItem.strokeWidth || 2 })}
                                        className="w-5 h-5 rounded cursor-pointer border-none bg-transparent"
                                    />
                                 </div>
                                 <div className="flex items-center gap-2">
                                     <input 
                                        type="range" min="0" max="20" step="0.5"
                                        value={selectedItem.strokeWidth || 0}
                                        onChange={(e) => updateSelectedItem({ strokeWidth: parseFloat(e.target.value) })}
                                        className="w-full h-1 bg-slate-600 rounded appearance-none accent-blue-500"
                                     />
                                     <span className="text-[10px] text-slate-500 w-4">{selectedItem.strokeWidth || 0}</span>
                                 </div>
                             </div>

                             {/* Background Settings */}
                             <div className="mt-2 pt-2 border-t border-slate-700">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-xs text-slate-400">文字底框</label>
                                    <button onClick={() => updateSelectedItem({ backgroundColor: selectedItem.backgroundColor ? undefined : '#000000', backgroundOpacity: 0.7, backgroundPadding: 10, backgroundRadius: 4 })} className={`text-[10px] px-2 py-0.5 rounded transition-colors ${selectedItem.backgroundColor ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400'}`}>
                                        {selectedItem.backgroundColor ? '已開啟' : '開啟'}
                                    </button>
                                </div>
                                {selectedItem.backgroundColor && (
                                    <div className="space-y-2 bg-slate-800 p-2 rounded">
                                         <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-slate-400">底色</span>
                                            <input type="color" value={selectedItem.backgroundColor} onChange={(e) => updateSelectedItem({ backgroundColor: e.target.value })} className="w-5 h-5 rounded cursor-pointer border-none bg-transparent" />
                                        </div>
                                        <div>
                                            <div className="flex justify-between text-[10px] text-slate-400"><span>透明度</span><span>{(selectedItem.backgroundOpacity || 0.7).toFixed(1)}</span></div>
                                            <input type="range" min="0" max="1" step="0.1" value={selectedItem.backgroundOpacity ?? 0.7} onChange={(e) => updateSelectedItem({ backgroundOpacity: parseFloat(e.target.value) })} className="w-full h-1 bg-slate-600 rounded appearance-none accent-blue-500" />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <div className="flex justify-between text-[10px] text-slate-400"><span>內距</span><span>{selectedItem.backgroundPadding || 10}</span></div>
                                                <input type="range" min="0" max="50" step="1"
                                                    value={selectedItem.backgroundPadding ?? 10}
                                                    onChange={(e) => updateSelectedItem({ backgroundPadding: parseInt(e.target.value) })}
                                                    className="w-full h-1 bg-slate-600 rounded appearance-none accent-blue-500"
                                                />
                                            </div>
                                            <div>
                                                <div className="flex justify-between text-[10px] text-slate-400"><span>圓角</span><span>{selectedItem.backgroundRadius || 4}</span></div>
                                                <input type="range" min="0" max="50" step="1"
                                                    value={selectedItem.backgroundRadius ?? 4}
                                                    onChange={(e) => updateSelectedItem({ backgroundRadius: parseInt(e.target.value) })}
                                                    className="w-full h-1 bg-slate-600 rounded appearance-none accent-blue-500"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                             </div>
                         </div>
                     )}
                 </div>
            )}
            {selectedItem && isCropping && selectedItem.type === 'image' && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-amber-600 text-white text-xs px-4 py-1 rounded-full shadow animate-pulse pointer-events-none z-40">裁切模式：拖曳橘框調整範圍，拖曳照片調整位置</div>
            )}
         </div>
      </div>
    </div>
  );
};

export default CollageGenerator;