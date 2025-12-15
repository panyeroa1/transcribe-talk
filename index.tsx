/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */

import {GoogleGenAI, LiveServerMessage, Modality} from '@google/genai';
import { createClient } from '@supabase/supabase-js';

// Live API supports 16kHz or 24kHz.
const SAMPLE_RATE = 16000;
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

// Supabase Configuration
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type AudioSourceType = 'mic' | 'tab';

class OrbitsTranscribe {
  private genAI: GoogleGenAI | null = null;
  private sessionPromise: Promise<any> | null = null;
  private currentSourceType: AudioSourceType = 'mic';
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private isConnected = false;

  // Media State
  private isMuted = false;
  private isVideoOff = false;

  // Streaming State (UI)
  private charQueue: string[] = [];
  private isRendering = false;
  private virtualLastChar = ''; // Tracks the hypothetical end of the stream for spacing logic

  // Database State
  private dbBuffer = ''; // Accumulates text for sentence detection

  // UI Elements
  private widget: HTMLDivElement;
  private settingsToggle: HTMLButtonElement;
  private captionsTrigger: HTMLDivElement;
  private captionContent: HTMLDivElement;
  private sourceBtns: NodeListOf<HTMLButtonElement>;
  private languageSelect: HTMLSelectElement;
  private videoElement: HTMLVideoElement; // Loopback
  private selfVideoElement: HTMLVideoElement; // Self View

  // Control Buttons
  private btnMute: HTMLDivElement;
  private btnVideo: HTMLDivElement;
  private hapticBtns: NodeListOf<Element>;

  constructor() {
    // UI Initialization
    this.widget = document.getElementById('transcriptionWidget') as HTMLDivElement;
    this.settingsToggle = document.getElementById('settingsToggle') as HTMLButtonElement;
    this.captionsTrigger = document.getElementById('captionsTrigger') as HTMLDivElement;
    this.captionContent = document.getElementById('captionContent') as HTMLDivElement;
    this.sourceBtns = document.querySelectorAll('.pill-btn') as NodeListOf<HTMLButtonElement>;
    this.languageSelect = document.getElementById('languageSelect') as HTMLSelectElement;
    this.videoElement = document.getElementById('hiddenVideo') as HTMLVideoElement;
    this.selfVideoElement = document.getElementById('selfVideo') as HTMLVideoElement;
    
    this.btnMute = document.getElementById('btnMute') as HTMLDivElement;
    this.btnVideo = document.getElementById('btnVideo') as HTMLDivElement;
    this.hapticBtns = document.querySelectorAll('.haptic-btn, .control-item, .end-btn');

    this.initSelfVideo();
    this.bindEvents();
  }

  private async initSelfVideo() {
    // Immediately try to get camera for the self-view to look like a real meeting
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: { ideal: 640 }, height: { ideal: 360 } }, 
            audio: true 
        });
        this.selfVideoElement.srcObject = stream;
        
        // This is the primary stream for the meeting logic
        this.stream = stream; 
    } catch (e) {
        console.warn("Camera access denied or unavailable", e);
        this.btnVideo.classList.add('video-off');
        this.isVideoOff = true;
    }
  }

  private bindEvents() {
    // Haptic Effect & General Button Logic
    this.hapticBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (navigator.vibrate) navigator.vibrate(10); // Light tap
            
            // Visual feedback for non-functional buttons to feel "real"
            const target = e.currentTarget as HTMLElement;
            if (!target.id && !target.classList.contains('active-state')) {
                // Flash effect for placeholder buttons
                target.style.transform = 'scale(0.95)';
                setTimeout(() => target.style.transform = '', 100);
            }
        });
    });

    // Toggle Settings
    this.settingsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.widget.classList.toggle('settings-open');
    });

    // Toggle Captions (Connect/Disconnect)
    this.captionsTrigger.addEventListener('click', () => {
      if (this.isConnected) {
        this.disconnect();
      } else {
        this.connect();
      }
    });

    // Mute Logic
    this.btnMute.addEventListener('click', () => {
        this.toggleMute();
    });

    // Video Logic
    this.btnVideo.addEventListener('click', () => {
        this.toggleVideo();
    });

    // Source Selection
    this.sourceBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.isConnected) return;
        this.sourceBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentSourceType = btn.dataset.source as AudioSourceType;
      });
    });
  }

  private toggleMute() {
      this.isMuted = !this.isMuted;
      // Update UI
      if (this.isMuted) {
          this.btnMute.classList.add('muted');
          this.btnMute.querySelector('span')!.textContent = 'Unmute';
      } else {
          this.btnMute.classList.remove('muted');
          this.btnMute.querySelector('span')!.textContent = 'Mute';
      }

      // Update actual tracks
      if (this.stream) {
          this.stream.getAudioTracks().forEach(t => t.enabled = !this.isMuted);
      }
  }

  private toggleVideo() {
      this.isVideoOff = !this.isVideoOff;
      // Update UI
      if (this.isVideoOff) {
          this.btnVideo.classList.add('video-off');
          this.btnVideo.querySelector('span')!.textContent = 'Start Video';
      } else {
          this.btnVideo.classList.remove('video-off');
          this.btnVideo.querySelector('span')!.textContent = 'Stop Video';
      }

      // Update actual tracks
      if (this.stream) {
          this.stream.getVideoTracks().forEach(t => t.enabled = !this.isVideoOff);
      }
  }

  private updateUIState(state: 'connected' | 'disconnected' | 'connecting') {
    if (state === 'connected') {
        this.widget.classList.remove('hidden');
        this.captionsTrigger.classList.add('active-state');
        this.captionContent.innerHTML = '<span class="placeholder-text">Listening...</span>';
    } else if (state === 'disconnected') {
        this.widget.classList.add('hidden');
        this.captionsTrigger.classList.remove('active-state');
        this.widget.classList.remove('settings-open');
    } else if (state === 'connecting') {
        this.captionsTrigger.style.opacity = '0.7';
    }
    
    if (state !== 'connecting') {
        this.captionsTrigger.style.opacity = '1';
    }
  }

  private async connect() {
    try {
      this.updateUIState('connecting');
      this.charQueue = []; 
      this.virtualLastChar = '';
      this.dbBuffer = ''; // Reset DB buffer

      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        alert('API Key is missing.');
        this.updateUIState('disconnected');
        return;
      }
      this.genAI = new GoogleGenAI({ apiKey });

      let streamToProcess: MediaStream;

      // 1. Determine Source
      if (this.currentSourceType === 'mic') {
        // Use the existing stream if available and active (from initSelfVideo)
        if (this.stream && this.stream.active) {
            streamToProcess = this.stream;
        } else {
            // Fallback if init failed or stream died
            // Requesting Aggressive Noise Cancellation for "Voice Focus"
            streamToProcess = await navigator.mediaDevices.getUserMedia({
                audio: { 
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            this.stream = streamToProcess;
        }
      } else {
        // Tab Audio
        try {
          streamToProcess = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                echoCancellation: false,
                noiseSuppression: false
            },
          });
          this.videoElement.srcObject = streamToProcess;
          this.videoElement.muted = true;
        } catch (e) {
          this.updateUIState('disconnected');
          return;
        }
      }

      // 2. Audio Context
      this.audioContext = new AudioContext({sampleRate: SAMPLE_RATE});
      this.sourceNode = this.audioContext.createMediaStreamSource(streamToProcess);

      // 3. Connect Gemini
      const selectedLang = this.languageSelect.value;
      let languageInstruction = 'The user is speaking in an auto-detected language.';

      if (selectedLang !== 'auto') {
        const langName = this.languageSelect.options[this.languageSelect.selectedIndex].text;
        languageInstruction = `The user is speaking in ${langName}. Transcribe exactly what is said in ${langName}.`;
      }

      const systemInstruction = `
        You are an expert real-time transcriber. 
        Your ONLY job is to transcribe the input audio into text accurately.
        ${languageInstruction}
        Do not add timestamps. Do not speak back to the user.
        Output distinct sentences separated by spaces.
        Ensure you use proper capitalization and punctuation.
        If the audio is silent or unintelligible, output nothing.
      `;

      this.sessionPromise = this.genAI.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO], 
          inputAudioTranscription: {},
          systemInstruction: { parts: [{ text: systemInstruction }] },
        },
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            this.updateUIState('connected');
            this.startAudioProcessing();
          },
          onmessage: this.handleSessionMessage.bind(this),
          onclose: () => {
            this.disconnect();
          },
          onerror: (err) => {
            console.error(err);
            this.disconnect();
          },
        },
      });

    } catch (error) {
      console.error('Connection failed:', error);
      this.disconnect();
    }
  }

  private startAudioProcessing() {
    if (!this.audioContext || !this.sourceNode || !this.sessionPromise) return;

    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmData = this.floatTo16BitPCM(inputData);
      const pcmBase64 = this.arrayBufferToBase64(pcmData);

      this.sessionPromise?.then((session) => {
        session.sendRealtimeInput({
          media: {
            mimeType: 'audio/pcm;rate=16000',
            data: pcmBase64,
          },
        });
      });
    };

    this.sourceNode.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  private handleSessionMessage(message: LiveServerMessage) {
    const content = message.serverContent as any;
    const inputTranscript = content?.inputTranscription;
    if (inputTranscript && inputTranscript.text) {
        // 1. Push to UI Queue
        this.queueText(inputTranscript.text);
        // 2. Process for Database
        this.processForDatabase(inputTranscript.text);
    }
  }

  // --- DATABASE LOGIC ---

  private processForDatabase(text: string) {
    this.dbBuffer += text;

    // Regex to find the first complete sentence followed by whitespace.
    // Looks for one or more non-punctuation chars, followed by one or more punctuation chars [.!?],
    // followed by whitespace (to confirm sentence end vs abbreviation like Mr. - simple heuristic).
    const sentenceMatch = this.dbBuffer.match(/^(.+?[.!?]+)\s+/);

    if (sentenceMatch) {
        const sentence = sentenceMatch[1];
        // Save the sentence
        this.saveSentence(sentence);

        // Remove the processed sentence from buffer (keeping the rest)
        this.dbBuffer = this.dbBuffer.slice(sentenceMatch[0].length);

        // Recurse: There might be more sentences in the buffer (e.g., a fast burst)
        // We pass empty string just to trigger re-check
        this.processForDatabase('');
    }
  }

  private async saveSentence(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    try {
        const { error } = await supabase.from('transcripts').insert({
            type: 'live',
            source_input: trimmed
        });
        
        if (error) {
            console.error('Supabase Error:', error.message);
        } else {
            console.log('Saved sentence:', trimmed);
        }
    } catch (err) {
        console.error('Save failed:', err);
    }
  }

  // --- UI STREAMING LOGIC ---

  /**
   * Pushes text to a queue to be animated.
   * Calculates proper spacing relative to the *future* state of the text.
   */
  private queueText(newText: string) {
      if (!newText) return;
      
      // Clean up placeholder on first real data
      const placeholder = this.captionContent.querySelector('.placeholder-text');
      if (placeholder) {
          placeholder.remove();
          this.virtualLastChar = ''; // Reset
      }

      // Spacing Logic
      const isPunctuation = /^[.,!?;:]/.test(newText);
      const endsInSpace = this.virtualLastChar === ' ';
      
      let textToAdd = newText;
      if (this.virtualLastChar.length > 0 && !endsInSpace && !isPunctuation && !newText.startsWith(' ')) {
          textToAdd = ' ' + newText;
      }
      
      // Update virtual cursor
      this.virtualLastChar = textToAdd.slice(-1);

      // Push individual characters to queue
      for (const char of textToAdd) {
          this.charQueue.push(char);
      }

      // Start the loop if sleeping
      if (!this.isRendering) {
          this.isRendering = true;
          this.renderLoop();
      }
  }

  /**
   * The Heartbeat: Renders characters from the queue at a high frame rate.
   */
  private renderLoop = () => {
      if (this.charQueue.length === 0) {
          this.isRendering = false;
          return;
      }

      // Dynamic Speed: If queue is backing up, render more chars per frame.
      const speedMultiplier = this.charQueue.length > 50 ? 5 : (this.charQueue.length > 10 ? 2 : 1);
      
      for (let i = 0; i < speedMultiplier; i++) {
          const char = this.charQueue.shift();
          if (char) {
              this.appendCharToDisplay(char);
          }
          if (this.charQueue.length === 0) break;
      }

      requestAnimationFrame(this.renderLoop);
  }

  /**
   * DOM Manipulation: Appends a single character, managing the "2-line" limit.
   */
  private appendCharToDisplay(char: string) {
      let currentSpan = this.captionContent.lastElementChild as HTMLElement;
      
      // Create new line if needed
      if (!currentSpan || currentSpan.classList.contains('finalized')) {
          currentSpan = document.createElement('div');
          currentSpan.className = 'caption-line streaming-segment';
          this.captionContent.appendChild(currentSpan);
      }
      
      currentSpan.textContent = (currentSpan.textContent || '') + char;

      // Line breaking logic: 85 chars limit
      if (currentSpan.textContent.length > 85 && char === ' ') {
          currentSpan.classList.remove('streaming-segment');
          currentSpan.classList.add('finalized');
      }

      // Pruning: Max 2 lines
      while (this.captionContent.children.length > 2) {
          this.captionContent.removeChild(this.captionContent.children[0]);
      }
  }

  private disconnect() {
    this.isConnected = false;
    this.updateUIState('disconnected');

    // Flush remaining buffer to DB
    if (this.dbBuffer.trim()) {
        this.saveSentence(this.dbBuffer);
        this.dbBuffer = '';
    }

    if (this.sessionPromise) {
        this.sessionPromise.then(session => session.close());
        this.sessionPromise = null;
    }

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    // Stop Tab stream if active
    if (this.currentSourceType === 'tab' && this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.videoElement.srcObject = null;
    }
  }

  private floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new OrbitsTranscribe();
});
