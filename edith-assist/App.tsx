import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Platform, Pressable, ScrollView,
  StatusBar, StyleSheet, Text, View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import * as Speech from "expo-speech";
import { analyze, checkServer } from "./api";

// "id" is what the backend understands. "label" is what the user sees.
const MODES = [
  { id: "describe", label: "Describe", full: "Describe" },
  { id: "read", label: "Read", full: "Read text" },
  { id: "explain", label: "Explain", full: "Explain" },
  { id: "translate", label: "Translate", full: "Translate" },
];

// "id" is sent to the backend.
const LANGUAGES = [
  { id: "English", label: "EN" },
  { id: "French", label: "FR" },
  { id: "Arabic", label: "AR" },
];

// Voice language codes (same as your web app)
const TTS_LANG: Record<string, string> = {
  English: "en-US",
  French: "fr-FR",
  Arabic: "ar-SA",
};

const TEST_SENTENCE: Record<string, string> = {
  English: "Hello, the voice is working.",
  French: "Bonjour, la voix fonctionne.",
  Arabic: "مرحبا، الصوت يعمل.",
};

const PAUSE_BETWEEN_FRAMES_MS = 3000;
const MAX_ERRORS_IN_A_ROW = 5;

const COLORS = {
  bg: "#10131a",
  panel: "#1a1f2b",
  border: "#33405a",
  text: "#f2f5fa",
  muted: "#aab4c5",
  accent: "#4da3ff",
  danger: "#ff6b6b",
  ok: "#3ecf8e",
  warn: "#ffb020",
};

const TOP_PADDING =
  Platform.OS === "android" ? (StatusBar.currentHeight ?? 24) + 8 : 56;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Reads text aloud with the phone's built-in voice.
// Cuts off anything already being spoken first.
async function speak(text: string, language: string) {
  try {
    if (await Speech.isSpeakingAsync()) {
      Speech.stop();
      await sleep(150); // give the phone a moment before the next sentence
    }
  } catch {
    // ignore
  }
  try {
    await Speech.speak(text, {
      language: TTS_LANG[language] ?? "en-US",
      rate: 0.95,
    });
  } catch {
    try {
      await Speech.speak(text, { rate: 0.95 });
    } catch {
      // Speech is optional; the answer remains visible if the phone has no voice.
    }
  }
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [live, setLive] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("describe");
  const [language, setLanguage] = useState("English");
  const [voiceOn, setVoiceOn] = useState(true);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");

  // null = checking, true = online, false = offline
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  // The loop reads these, so it always uses the latest choice
  const modeRef = useRef("describe");
  const languageRef = useRef("English");
  const voiceOnRef = useRef(true);
  const lastSpokenRef = useRef(""); // stops the same answer being read twice
  const [pulse] = useState(() => new Animated.Value(1));

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // Stop talking when the app closes
  useEffect(() => {
    return () => { Speech.stop(); };
  }, []);

  // Ask the server if it is alive
  async function testServer() {
    setServerOk(null);
    const result = await checkServer();
    setServerOk(result.ok);
    if (!result.ok) setError(result.message);
    else setError("");
  }

  // Check once when the app opens
  useEffect(() => {
    const timer = setTimeout(() => { void testServer(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Pulsing red dot while live
  useEffect(() => {
    if (!live) {
      pulse.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [live, pulse]);

  // The live loop
  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    async function loop() {
      let errorsInARow = 0;

      while (!cancelled) {
        try {
          if (!cameraReady) {
            await sleep(100);
            continue;
          }
          setBusy(true);
          const frame = await cameraRef.current?.takePictureAsync({
            quality: 0.5,
            skipProcessing: true,
            shutterSound: false, // if TypeScript complains about this line, delete it
          });
          if (!frame || cancelled) break;

          const small = await ImageManipulator.manipulateAsync(
            frame.uri,
            [{ resize: { width: 768 } }],
            { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );

          const lang = languageRef.current;
          const result = await analyze(
            small.base64 ?? "",
            modeRef.current,
            "",
            lang
          );
          if (cancelled) break;

          setAnswer(result);
          setError("");
          setServerOk(true);
          errorsInARow = 0;

          // Read it aloud, but only if it is new
          const key = normalize(result) + "|" + lang;
          if (voiceOnRef.current && key !== lastSpokenRef.current) {
            lastSpokenRef.current = key;
            speak(result, lang);
          }
        } catch (e) {
          errorsInARow++;
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
          }
          if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
            setError("Stopped after too many errors. Check the server light, then press Start.");
            setServerOk(false);
            setLive(false);
            break;
          }
        } finally {
          setBusy(false);
        }
        await sleep(PAUSE_BETWEEN_FRAMES_MS);
      }
    }

    loop();
    return () => {
      cancelled = true;
      setBusy(false);
      Speech.stop(); // stop talking when live ends
    };
  }, [cameraReady, live]);

  // ---------- permission screens ----------
  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.accent} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.logo}>OPTIMA</Text>
        <Text style={styles.logoSub}>Assist</Text>
        <Text style={styles.permText}>
          OPTIMA Assist needs your camera to describe what is in front of you.
        </Text>
        <Pressable
          style={styles.primaryButton}
          onPress={requestPermission}
          accessibilityRole="button"
          accessibilityLabel="Allow camera access"
        >
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  // ---------- main screen ----------
  const statusText = !live ? "Ready" : busy ? "Looking…" : "Watching";
  const modeFull = MODES.find((m) => m.id === mode)?.full ?? mode;

  const serverColor =
    serverOk === null ? COLORS.warn : serverOk ? COLORS.ok : COLORS.danger;
  const serverLabel =
    serverOk === null ? "Checking…" : serverOk ? "Online" : "Offline";

  function toggleVoice(on: boolean) {
    setVoiceOn(on);
    if (!on) Speech.stop();
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        onCameraReady={() => setCameraReady(true)}
      />

      {/* top bar */}
      <View style={styles.topBar}>
        <View style={styles.titlePill}>
          <Text style={styles.title}>E.D.I.T.H. Assist</Text>
        </View>

        <View style={styles.topRight}>
          {live && (
            <View style={styles.pill} accessible accessibilityLabel="Live assist is on">
              <Animated.View style={[styles.dot, { backgroundColor: COLORS.danger, opacity: pulse }]} />
              <Text style={[styles.pillText, { color: COLORS.danger }]}>LIVE</Text>
            </View>
          )}

          {/* server status light: tap to check again */}
          <Pressable
            style={styles.pill}
            onPress={testServer}
            accessibilityRole="button"
            accessibilityLabel={`Server ${serverLabel}. Tap to check again.`}
          >
            <View style={[styles.dot, { backgroundColor: serverColor }]} />
            <Text style={[styles.pillText, { color: serverColor }]}>{serverLabel}</Text>
          </Pressable>
        </View>
      </View>

      {/* middle area: side column on the right */}
      <View style={styles.middle}>
        <View style={styles.rail}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.railContent}>
            <Text style={styles.railTitle}>Mode</Text>
            {MODES.map((m) => {
              const selected = m.id === mode;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => setMode(m.id)}
                  style={[styles.sideChip, selected && styles.sideChipSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Mode ${m.full}`}
                >
                  <Text style={[styles.sideChipText, selected && styles.sideChipTextSelected]}>
                    {m.label}
                  </Text>
                </Pressable>
              );
            })}

            <View style={styles.railDivider} />

            <Text style={styles.railTitle}>Language</Text>
            {LANGUAGES.map((l) => {
              const selected = l.id === language;
              return (
                <Pressable
                  key={l.id}
                  onPress={() => setLanguage(l.id)}
                  style={[styles.sideChip, selected && styles.sideChipSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Language ${l.id}`}
                >
                  <Text style={[styles.sideChipText, selected && styles.sideChipTextSelected]}>
                    {l.label}
                  </Text>
                </Pressable>
              );
            })}

            <View style={styles.railDivider} />

            <Text style={styles.railTitle}>Voice</Text>
            <Pressable
              onPress={() => toggleVoice(true)}
              style={[styles.sideChip, voiceOn && styles.sideChipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: voiceOn }}
              accessibilityLabel="Voice on"
            >
              <Text style={[styles.sideChipText, voiceOn && styles.sideChipTextSelected]}>On</Text>
            </Pressable>
            <Pressable
              onPress={() => toggleVoice(false)}
              style={[styles.sideChip, !voiceOn && styles.sideChipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: !voiceOn }}
              accessibilityLabel="Voice off"
            >
              <Text style={[styles.sideChipText, !voiceOn && styles.sideChipTextSelected]}>Off</Text>
            </Pressable>
            <Pressable
              onPress={() => answer && speak(answer, language)}
              style={styles.sideChip}
              accessibilityRole="button"
              accessibilityLabel="Repeat the last answer"
            >
              <Text style={styles.sideChipText}>Repeat</Text>
            </Pressable>
            <Pressable
              onPress={() => speak(TEST_SENTENCE[language] ?? TEST_SENTENCE.English, language)}
              style={styles.sideChip}
              accessibilityRole="button"
              accessibilityLabel="Test the voice"
            >
              <Text style={styles.sideChipText}>Test</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>

      {/* bottom sheet: answer + big button */}
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.answerCard} accessibilityLiveRegion="polite">
          <View style={styles.answerHeader}>
            <Text style={styles.answerLabel}>
              {modeFull.toUpperCase()} · {language.toUpperCase()}
            </Text>
            <View style={styles.statusRow}>
              {live && busy && <ActivityIndicator size="small" color={COLORS.accent} />}
              <Text style={styles.statusText}> {statusText}</Text>
            </View>
          </View>
          <ScrollView style={styles.answerScroll} nestedScrollEnabled>
            <Text style={styles.answerText}>
              {answer || "Press Start and point the camera at something."}
            </Text>
            {error !== "" && <Text style={styles.errorText}>{error}</Text>}
          </ScrollView>
        </View>

        <View style={styles.controls}>
          <Pressable
            onPress={() => {
              if (live) {
                setLive(false);
              } else {
                if (!cameraReady) {
                  setError("The camera is still starting. Please try again in a moment.");
                  return;
                }
                setError("");
                setAnswer("");
                lastSpokenRef.current = "";
                if (serverOk !== true) testServer();
                setLive(true);
              }
            }}
            disabled={!live && !cameraReady}
            style={[
              styles.bigButton,
              !live && !cameraReady && styles.bigButtonDisabled,
              live && styles.bigButtonStop,
            ]}
            accessibilityRole="button"
            accessibilityLabel={live ? "Stop live assist" : "Start live assist"}
          >
            {live ? <View style={styles.stopSquare} /> : <View style={styles.playTriangle} />}
          </Pressable>
          <Text style={styles.controlLabel}>
            {live ? "Tap to stop" : cameraReady ? "Tap to start" : "Starting camera…"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: {
    flex: 1, backgroundColor: COLORS.bg,
    alignItems: "center", justifyContent: "center", padding: 28,
  },

  // permission screen
  logo: { color: COLORS.text, fontSize: 34, fontWeight: "800", letterSpacing: 2 },
  logoSub: { color: COLORS.accent, fontSize: 20, fontWeight: "600", marginBottom: 24 },
  permText: {
    color: COLORS.muted, fontSize: 17, lineHeight: 25,
    textAlign: "center", marginBottom: 28,
  },
  primaryButton: {
    backgroundColor: COLORS.accent, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 14,
  },
  primaryButtonText: { color: "#04121f", fontSize: 18, fontWeight: "700" },

  // top bar
  topBar: {
    paddingTop: TOP_PADDING, paddingHorizontal: 12, paddingBottom: 8,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  titlePill: {
    backgroundColor: "rgba(16,19,26,0.75)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
  },
  title: { color: COLORS.text, fontSize: 14, fontWeight: "700", letterSpacing: 0.5 },
  topRight: { flexDirection: "row", gap: 8 },
  pill: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(16,19,26,0.75)", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 20,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  pillText: { fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },

  // middle area (holds the side column)
  middle: { flex: 1, flexDirection: "row", justifyContent: "flex-end", paddingRight: 10 },

  // side column
  rail: {
    width: 88,
    backgroundColor: "rgba(16,19,26,0.82)",
    borderRadius: 20,
    borderWidth: 1, borderColor: COLORS.border,
    marginVertical: 4,
  },
  railContent: { padding: 8, alignItems: "stretch" },
  railTitle: {
    color: COLORS.muted, fontSize: 11, fontWeight: "800",
    letterSpacing: 1, textTransform: "uppercase",
    textAlign: "center", marginBottom: 6, marginTop: 4,
  },
  railDivider: { height: 1, backgroundColor: COLORS.border, marginVertical: 10 },
  sideChip: {
    paddingVertical: 10, borderRadius: 14, marginBottom: 6,
    borderWidth: 1.5, borderColor: COLORS.border, alignItems: "center",
  },
  sideChipSelected: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  sideChipText: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  sideChipTextSelected: { color: "#04121f" },

  // bottom sheet
  sheet: {
    backgroundColor: "rgba(16,19,26,0.94)",
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28,
  },
  handle: {
    alignSelf: "center", width: 44, height: 5, borderRadius: 3,
    backgroundColor: COLORS.border, marginBottom: 12,
  },
  answerCard: {
    backgroundColor: COLORS.panel, borderRadius: 16,
    borderWidth: 1, borderColor: COLORS.border, padding: 14,
  },
  answerHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6,
  },
  answerLabel: { color: COLORS.accent, fontSize: 12, fontWeight: "800", letterSpacing: 1.2 },
  statusRow: { flexDirection: "row", alignItems: "center" },
  statusText: { color: COLORS.muted, fontSize: 13 },
  answerScroll: { maxHeight: 110, flexGrow: 0 },
  answerText: { color: COLORS.text, fontSize: 19, lineHeight: 27 },
  errorText: { color: COLORS.danger, fontSize: 14, marginTop: 8 },

  // big button
  controls: { alignItems: "center", marginTop: 12 },
  bigButton: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.accent,
    alignItems: "center", justifyContent: "center",
    borderWidth: 4, borderColor: "rgba(255,255,255,0.25)",
  },
  bigButtonStop: { backgroundColor: COLORS.danger },
  bigButtonDisabled: { opacity: 0.5 },
  playTriangle: {
    marginLeft: 6, width: 0, height: 0,
    borderTopWidth: 14, borderBottomWidth: 14, borderLeftWidth: 22,
    borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "#04121f",
  },
  stopSquare: { width: 24, height: 24, borderRadius: 4, backgroundColor: "#2a0505" },
  controlLabel: { color: COLORS.muted, fontSize: 14, marginTop: 8 },
});