// src/lib/askPharmaSaathi.js
const API_BASE =
    import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

const TIMEOUT_MS = 15000;

/**
 * Single API client for Pharma Saathi backend.
 * Sends JSON POST, has 15s timeout, and one retry on network failure.
 */
export async function askPharmaSaathi(message, language = "english", sessionId) {
    const url = `${API_BASE}/api/stand-in/ask`;

    const body = JSON.stringify({
        message: message.trim().slice(0, 1000),
        language,
        sessionId,
    });

    const attempt = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!res.ok) {
                // Don't retry on 4xx (client errors)
                if (res.status >= 400 && res.status < 500) {
                    const errData = await res.json().catch(() => ({}));
                    const error = new Error(
                        errData.error || `Request failed (${res.status})`
                    );
                    error.noRetry = true;
                    throw error;
                }
                // 5xx errors can retry
                throw new Error(`Server error (${res.status})`);
            }

            const data = await res.json();

            // Validate shape — treat unknown as escalate
            if (!data || typeof data.answer !== "string") {
                return {
                    route: "escalate",
                    answer:
                        "Response could not be verified safely. Please consult a pharmacist or doctor.",
                    category: "other",
                    riskLevel: "medium",
                    shouldEscalate: true,
                    escalationReason: "Invalid response from backend",
                    sourceIds: [],
                    limitations: [],
                };
            }

            return data;
        } catch (err) {
            clearTimeout(timeoutId);

            if (err.name === "AbortError") {
                const e = new Error("Request timed out. Please try again.");
                e.name = "TimeoutError";
                throw e;
            }

            throw err;
        }
    };

    // First attempt
    try {
        return await attempt();
    } catch (err) {
        // Don't retry 4xx errors
        if (err.noRetry) {
            throw err;
        }

        // One retry on network / timeout / 5xx
        console.warn("First attempt failed, retrying once:", err.message);
        return await attempt();
    }
}