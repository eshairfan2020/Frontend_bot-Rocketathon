import { useEffect, useRef, useState } from "react";
import { Camera, Mic, MicOff, Send } from "lucide-react";
import robot from "./assets/robot.png";
import { askPharmaSaathi } from "./lib/askPharmaSaathi";

const EYES = [
  { cx: 368, cy: 266 },
  { cx: 553, cy: 290 },
];

const EYE_MID_X = (368 + 553) / 2;
const EYE_MID_Y = (266 + 290) / 2;

const MOUTH = {
  cx: 441,
  cy: 380,
};

// In-memory session ID (no persistence)
const SESSION_ID = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function App() {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");

  const [look, setLook] = useState({ x: 0, y: 0 });

  const [mouth, setMouth] = useState(0);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [subtitle, setSubtitle] = useState("");

  // NEW: text input + response state
  const [userInput, setUserInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [responseData, setResponseData] = useState(null);

  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const svgRef = useRef(null);

  const recognitionRef = useRef(null);
  const stopRef = useRef(() => { });

  const speakingAnimationRef = useRef(null);
  const voicesRef = useRef([]);
  const speakingRef = useRef(false);
  const conversationActiveRef = useRef(false);

  // LOAD BROWSER VOICES
  useEffect(() => {
    if (!("speechSynthesis" in window)) {
      return;
    }

    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };

    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);

    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    };
  }, []);

  // CAMERA
  const openCamera = async () => {
    setCameraError("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not supported by this browser.");
      setCameraOpen(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      cameraStreamRef.current = stream;
      setCameraOpen(true);

      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch((error) => {
            console.warn("Video playback error:", error);
          });
        }
      });
    } catch (error) {
      console.error("Camera error:", error);

      if (error?.name === "NotAllowedError") {
        setCameraError(
          "Camera permission was denied. Please allow camera access and try again."
        );
      } else if (error?.name === "NotFoundError") {
        setCameraError("No camera was found on this device.");
      } else if (error?.name === "NotReadableError") {
        setCameraError(
          "The camera is already being used by another application."
        );
      } else {
        setCameraError("Unable to access the camera.");
      }

      setCameraOpen(true);
    }
  };

  const closeCamera = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraOpen(false);
    setCameraError("");
  };

  // EYE MOVEMENT
  useEffect(() => {
    const onMove = (event) => {
      const svg = svgRef.current;
      if (!svg) return;

      const rect = svg.getBoundingClientRect();
      const eyeX = rect.left + (EYE_MID_X / 928) * rect.width;
      const eyeY = rect.top + (EYE_MID_Y / 1152) * rect.height;

      const dx = event.clientX - eyeX;
      const dy = event.clientY - eyeY;
      const distance = Math.hypot(dx, dy) || 1;
      const strength = Math.min(1, distance / 300);

      setLook({
        x: (dx / distance) * 14 * strength,
        y: (dy / distance) * 12 * strength,
      });
    };

    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // TEXT TO SPEECH
  // Detect if text contains Urdu script (اردو)
  const hasUrduScript = (text) => /[\u0600-\u06FF]/.test(text);

  // Detect Roman Urdu words in English text
  const hasRomanUrdu = (text) =>
    /\b(aap|aapki|kya|hai|hain|ka|ki|ke|ko|mein|par|se|ye|woh|karein|lein|rahe|rahi|raha|sakte|sakti|nahi|nahin|ji|haan|foran|jayein|mat|abhi|to|bhi|aur|kuch|koi|sab|bhool|khali|pait|khana|khane|saath|rakhein|rakhna|batayein|poochein|milein)\b/i;

  const speak = (text) => {
    if (!text) return;

    if (!("speechSynthesis" in window)) {
      setSubtitle(
        "Your browser does not support voice. Please use Chrome or Edge."
      );
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voices =
      voicesRef.current.length > 0
        ? voicesRef.current
        : window.speechSynthesis.getVoices();

    const isUrduScript = hasUrduScript(text);
    const isRomanUrdu = hasRomanUrdu(text);
    const isUrdu = isUrduScript || isRomanUrdu;

    let selectedVoice = null;

    if (isUrdu) {
      // Priority order for Urdu:
      // 1. Urdu voice (ur-PK, ur-IN)
      // 2. Hindi voice (hi-IN) — can pronounce Roman Urdu reasonably
      // 3. Indian English voice (en-IN) — can pronounce Roman Urdu phonetically
      selectedVoice =
        voices.find((v) => v.lang.toLowerCase().startsWith("ur")) ||
        voices.find((v) => v.lang.toLowerCase().startsWith("hi")) ||
        voices.find((v) => v.lang === "en-IN") ||
        voices.find((v) =>
          /hindi|urdu|kalpana|heera|swara|ravi/i.test(v.name)
        );
    }

    // If no Urdu-specific voice, fall back to English for Roman Urdu
    // (English voice reads Roman Urdu phonetically — acceptable)
    // But for Urdu SCRIPT with no Urdu voice, skip speech (English voice would be garbled)
    if (!selectedVoice && isUrduScript) {
      // Cannot read Urdu script — show text only
      setSubtitle(
        text +
        "\n\n(Note: Urdu voice not available on this device. Displaying text only.)"
      );
      return;
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang;
    } else {
      // Fallback to English voice (works for Roman Urdu, not Urdu script)
      const englishVoice =
        voices.find(
          (v) =>
            v.lang === "en-US" &&
            /jenny|aria|zira|samantha|susan|hazel|female|google us english/i.test(
              v.name
            )
        ) ||
        voices.find((v) => v.lang === "en-US") ||
        voices.find((v) => v.lang.startsWith("en"));

      if (englishVoice) {
        utterance.voice = englishVoice;
        utterance.lang = englishVoice.lang;
      } else {
        utterance.lang = "en-US";
      }
    }

    // Voice settings — slower for Urdu (clearer pronunciation)
    utterance.rate = isUrdu ? 0.85 : 0.9;
    utterance.pitch = isUrdu ? 1.0 : 1.15;
    utterance.volume = 1;

    utterance.onstart = () => {
      setSpeaking(true);
      speakingRef.current = true;

      const start = performance.now();

      const animateSpeech = (time) => {
        const elapsed = (time - start) / 1000;

        const movement =
          0.15 +
          Math.abs(Math.sin(elapsed * 9)) * 0.65 +
          Math.abs(Math.sin(elapsed * 17)) * 0.2;

        setMouth(Math.min(1, movement));

        speakingAnimationRef.current = requestAnimationFrame(animateSpeech);
      };

      speakingAnimationRef.current = requestAnimationFrame(animateSpeech);
    };

    utterance.onend = () => {
      setSpeaking(false);
      speakingRef.current = false;

      if (speakingAnimationRef.current) {
        cancelAnimationFrame(speakingAnimationRef.current);
        speakingAnimationRef.current = null;
      }

      setMouth(0);

      if (conversationActiveRef.current) {
        setTimeout(() => {
          if (conversationActiveRef.current && !recognitionRef.current) {
            startSpeechRecognition();
          }
        }, 250);
      }
    };

    utterance.onerror = (error) => {
      console.error("Pharma Saathi voice error:", error);
      setSpeaking(false);
      speakingRef.current = false;

      if (speakingAnimationRef.current) {
        cancelAnimationFrame(speakingAnimationRef.current);
        speakingAnimationRef.current = null;
      }

      setMouth(0);
    };

    setTimeout(() => {
      window.speechSynthesis.speak(utterance);
    }, 50);
  };
  // =====================================================
  // ASK BACKEND — MAIN FUNCTION
  // =====================================================
  const handleAsk = async (text) => {
    const trimmed = (text || "").trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setResponseData(null);
    setSubtitle(trimmed);

    try {
      const data = await askPharmaSaathi(trimmed, "english", SESSION_ID);
      setResponseData(data);
      setSubtitle(data.answer);

      // Speak the answer
      speak(data.answer);
    } catch (err) {
      console.error("Backend error:", err);

      // Mock/fallback response
      const fallback = {
        route: "escalate",
        answer:
          err.name === "TimeoutError"
            ? "The request timed out. Please check your connection and try again, or consult your pharmacist."
            : "Could not reach the pharmacist system. Please try again or consult your pharmacist or doctor directly.",
        category: "other",
        riskLevel: "medium",
        shouldEscalate: true,
        escalationReason: err.message || "Backend unreachable",
        sourceIds: [],
        limitations: ["DEMO – offline fallback"],
      };

      setResponseData(fallback);
      setSubtitle(fallback.answer);
    } finally {
      setLoading(false);
    }
  };

  // SPEECH RECOGNITION
  const startSpeechRecognition = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSubtitle("Speech recognition is not supported in this browser.");
      return;
    }

    if (recognitionRef.current) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setSubtitle("Listening...");
    };

    recognition.onresult = (event) => {
      let text = "";
      let finalText = "";

      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        text += transcript + " ";
        if (result.isFinal) {
          finalText += transcript + " ";
        }
      }

      const spokenText = text.trim();
      const finalSpokenText = finalText.trim();

      if (spokenText) setSubtitle(spokenText);

      if (finalSpokenText) {
        stopSpeechRecognition();
        handleAsk(finalSpokenText);
      }
    };

    recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error);

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setSubtitle("Microphone permission was denied.");
      } else if (event.error === "no-speech") {
        setSubtitle("Listening...");
      }
    };

    recognition.onend = () => {
      if (
        conversationActiveRef.current &&
        !speakingRef.current &&
        recognitionRef.current === recognition
      ) {
        recognitionRef.current = null;

        setTimeout(() => {
          if (conversationActiveRef.current && !speakingRef.current) {
            startSpeechRecognition();
          }
        }, 150);
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (error) {
      console.warn("Speech recognition could not start:", error);
      recognitionRef.current = null;
    }
  };

  const stopSpeechRecognition = () => {
    if (!recognitionRef.current) return;

    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    try {
      recognition.onend = null;
      recognition.stop();
    } catch {
      // Already stopped.
    }
  };

  // MICROPHONE + MOUTH
  const toggleMic = async () => {
    if (listening) {
      conversationActiveRef.current = false;
      stopRef.current();
      stopRef.current = () => { };
      stopSpeechRecognition();
      setListening(false);
      setSubtitle("");
      setMouth(0);
      return;
    }

    conversationActiveRef.current = true;
    setListening(true);
    setSubtitle("Listening...");
    setResponseData(null);

    startSpeechRecognition();

    let animationFrame = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const AudioContext = window.AudioContext || window.webkitAudioContext;

      if (!AudioContext) {
        throw new Error("AudioContext is not supported.");
      }

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;

      const microphone = audioContext.createMediaStreamSource(stream);
      microphone.connect(analyser);

      const buffer = new Uint8Array(analyser.fftSize);

      const tick = () => {
        if (speakingRef.current) {
          animationFrame = requestAnimationFrame(tick);
          return;
        }

        analyser.getByteTimeDomainData(buffer);

        let sum = 0;
        for (const value of buffer) {
          sum += ((value - 128) / 128) ** 2;
        }

        const rms = Math.sqrt(sum / buffer.length);

        setMouth((current) => {
          const target = Math.min(1, rms * 8);
          return current * 0.5 + target * 0.5;
        });

        animationFrame = requestAnimationFrame(tick);
      };

      tick();

      stopRef.current = () => {
        cancelAnimationFrame(animationFrame);
        stream.getTracks().forEach((track) => track.stop());
        audioContext.close().catch(() => { });
      };
    } catch (error) {
      console.warn("Microphone unavailable:", error);

      const start = performance.now();

      const tick = (time) => {
        if (speakingRef.current) {
          animationFrame = requestAnimationFrame(tick);
          return;
        }

        const seconds = (time - start) / 1000;

        setMouth(
          Math.max(
            0,
            Math.sin(seconds * 11) * 0.6 + Math.sin(seconds * 5.3) * 0.4
          )
        );

        animationFrame = requestAnimationFrame(tick);
      };

      animationFrame = requestAnimationFrame(tick);

      stopRef.current = () => {
        cancelAnimationFrame(animationFrame);
      };
    }
  };

  // CLEANUP
  useEffect(() => {
    return () => {
      conversationActiveRef.current = false;
      stopRef.current();

      if (speakingAnimationRef.current) {
        cancelAnimationFrame(speakingAnimationRef.current);
      }

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }

      if (recognitionRef.current) {
        const recognition = recognitionRef.current;
        recognitionRef.current = null;
        try {
          recognition.onend = null;
          recognition.stop();
        } catch {
          // Already stopped.
        }
      }

      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach((track) => track.stop());
        cameraStreamRef.current = null;
      }
    };
  }, []);

  const mouthOpen = mouth * 20;

  // =====================================================
  // RESPONSE STATE STYLING
  // =====================================================
  const getResponseStyle = () => {
    if (!responseData) return null;

    const route = responseData.route;
    const risk = responseData.riskLevel;

    if (route === "emergency" || risk === "emergency") {
      return {
        bg: "bg-red-50/95",
        border: "border-red-400",
        text: "text-red-900",
        label: "🚨 EMERGENCY",
        labelColor: "text-red-700",
      };
    }

    if (route === "escalate") {
      return {
        bg: "bg-amber-50/95",
        border: "border-amber-400",
        text: "text-amber-900",
        label: "⚠️ CONSULT PHARMACIST",
        labelColor: "text-amber-700",
      };
    }

    if (route === "clarify") {
      return {
        bg: "bg-blue-50/95",
        border: "border-blue-300",
        text: "text-blue-900",
        label: "❓ MORE INFO NEEDED",
        labelColor: "text-blue-700",
      };
    }

    return {
      bg: "bg-white/90",
      border: "border-white/40",
      text: "text-[#2a1a33]",
      label: "PHARMA SAATHI",
      labelColor: "text-[#2a1a33]/50",
    };
  };

  const responseStyle = getResponseStyle();

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background">
      {/* Background */}
      <div className="pointer-events-none absolute inset-0 bg-aurora" />
      <div className="pointer-events-none absolute inset-0 bg-vignette" />

      {/* Pharma Sathi */}
      <div className="relative flex h-full w-full items-center justify-center">
        <div className="relative flex items-center justify-center">
          {/* Halo */}
          <div className="pointer-events-none absolute h-[70vh] w-[70vh] rounded-full bg-halo blur-3xl animate-halo" />

          {/* Robot */}
          <div className="relative animate-float">
            <img
              src={robot}
              alt="Pharma Sathi, a friendly AI robot scientist in a white lab coat"
              width={928}
              height={1152}
              className="relative h-[88vh] w-auto max-w-[92vw] drop-shadow-glow"
            />

            {/* Face animation */}
            <svg
              ref={svgRef}
              viewBox="0 0 928 1152"
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden="true"
            >
              <defs>
                {EYES.map((eye, index) => (
                  <clipPath key={index} id={`eye${index}`}>
                    <ellipse cx={eye.cx} cy={eye.cy} rx={40} ry={38} />
                  </clipPath>
                ))}
              </defs>

              {EYES.map((eye, index) => (
                <g key={index} clipPath={`url(#eye${index})`}>
                  <image
                    href={robot}
                    width={928}
                    height={1152}
                    x={look.x * 0.6}
                    y={look.y * 0.6}
                  />
                </g>
              ))}

              {mouthOpen < 2 ? (
                <path
                  d={`
                    M ${MOUTH.cx - 32} ${MOUTH.cy - 6}
                    Q ${MOUTH.cx} ${MOUTH.cy + 10} ${MOUTH.cx + 32} ${MOUTH.cy - 4}
                  `}
                  stroke="#2a1a33"
                  strokeWidth="4"
                  fill="none"
                  strokeLinecap="round"
                />
              ) : (
                <ellipse
                  cx={MOUTH.cx}
                  cy={MOUTH.cy + mouthOpen / 3}
                  rx={26 - mouth * 4}
                  ry={mouthOpen / 2 + 3}
                  fill="#2a1a33"
                />
              )}
            </svg>
          </div>

          {/* LIVE SUBTITLE / RESPONSE BOX */}
          {(listening || responseData || loading) && (
            <div
              className={`
                absolute
                left-[calc(100%+28px)]
                top-[24%]
                z-[100]
                w-[min(400px,34vw)]
                min-w-[280px]
                max-h-[60vh]
                overflow-y-auto
                rounded-2xl
                border
                px-5
                py-4
                shadow-[0_20px_60px_rgba(42,26,51,0.18)]
                backdrop-blur-xl
                transition-all
                ${responseStyle ? responseStyle.bg : "bg-white/90"}
                ${responseStyle ? responseStyle.border : "border-white/40"}
              `}
              aria-live="polite"
            >
              <div
                className={`
                  absolute
                  -left-2
                  top-7
                  h-4
                  w-4
                  rotate-45
                  border-b
                  border-l
                  ${responseStyle ? responseStyle.border : "border-white/40"}
                  ${responseStyle ? responseStyle.bg : "bg-white/90"}
                `}
              />

              <div
                className={`
                  relative
                  mb-1.5
                  text-[10px]
                  font-bold
                  uppercase
                  tracking-[0.2em]
                  ${responseStyle ? responseStyle.labelColor : "text-[#2a1a33]/50"}
                `}
              >
                {responseStyle ? responseStyle.label : "PHARMA SAATHI"}
              </div>

              <div
                className={`
                  relative
                  text-[16px]
                  font-medium
                  leading-relaxed
                  ${responseStyle ? responseStyle.text : "text-[#2a1a33]"}
                `}
              >
                {loading ? (
                  <span className="opacity-70">Thinking…</span>
                ) : responseData ? (
                  <span>{responseData.answer}</span>
                ) : (
                  <span>{subtitle || "Listening..."}</span>
                )}
              </div>

              {responseData && responseData.limitations && responseData.limitations.length > 0 && (
                <div className="mt-3 pt-3 border-t border-black/10">
                  <p className="text-[10px] uppercase tracking-wider opacity-50">
                    {responseData.limitations.join(" · ")}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Controls */}
          <div className="absolute bottom-[22%] left-[calc(50%+min(38vh,30vw))] flex flex-col items-center gap-4">
            <button
              type="button"
              aria-label={listening ? "Stop microphone" : "Use microphone"}
              onClick={toggleMic}
              className="control-button"
            >
              {listening ? (
                <MicOff className="size-6" strokeWidth={2.2} />
              ) : (
                <Mic className="size-6" strokeWidth={2.2} />
              )}
            </button>

            <button
              type="button"
              aria-label="Use camera"
              onClick={openCamera}
              className="control-button"
            >
              <Camera className="size-6" strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>

      {/* TEXT INPUT (mic fallback) */}
      <div className="absolute bottom-[8%] left-1/2 z-[200] flex w-[min(540px,82vw)] -translate-x-1/2 gap-2">
        <input
          type="text"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading && userInput.trim()) {
              handleAsk(userInput);
              setUserInput("");
            }
          }}
          placeholder="Type your question… (e.g., How do I store insulin?)"
          disabled={loading}
          className="
            flex-1
            rounded-full
            border
            border-white/40
            bg-white/90
            px-5
            py-3
            text-[15px]
            text-[#2a1a33]
            shadow-[0_10px_40px_rgba(42,26,51,0.15)]
            backdrop-blur-xl
            outline-none
            focus:border-plum-400
            disabled:opacity-60
          "
        />
        <button
          type="button"
          onClick={() => {
            if (!loading && userInput.trim()) {
              handleAsk(userInput);
              setUserInput("");
            }
          }}
          disabled={loading || !userInput.trim()}
          aria-label="Send question"
          className="
            control-button
            disabled:opacity-40
            disabled:cursor-not-allowed
          "
        >
          <Send className="size-5" strokeWidth={2.2} />
        </button>
      </div>

      {/* Test voice button */}
      <button
        type="button"
        aria-label="Test Pharma Sathi voice"
        onClick={() =>
          speak(
            "Hello! I am Pharma Saathi. I can speak now. How can I help you?"
          )
        }
        className="control-button"
      >
        🔊
      </button>

      {/* CAMERA OVERLAY */}
      {cameraOpen && (
        <div
          className="camera-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Camera preview"
        >
          <div className="camera-panel">
            <div className="camera-header">
              <div>
                <p className="camera-title">Camera</p>
                <p className="camera-status">
                  {cameraError ? "Camera unavailable" : "Live preview"}
                </p>
              </div>

              <button
                type="button"
                onClick={closeCamera}
                className="camera-close"
                aria-label="Close camera"
              >
                ×
              </button>
            </div>

            {cameraError ? (
              <div className="camera-error">
                <p>{cameraError}</p>
                <button
                  type="button"
                  onClick={openCamera}
                  className="camera-retry"
                >
                  Try again
                </button>
              </div>
            ) : (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="camera-video"
              />
            )}
          </div>
        </div>
      )}
    </main>
  );
}