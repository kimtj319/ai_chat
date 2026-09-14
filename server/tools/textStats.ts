import type { ToolDefinition } from "./types.js";

const MAX_INPUT_CHARS = 200_000;
const TOP_WORDS_COUNT = 10;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for", "with", "as", "is", "are",
  "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "at", "by", "from", "not",
  "no", "so", "we", "you", "i", "he", "she", "they", "them", "his", "her", "their", "our", "your", "my", "me",
  "us", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "should", "may", "might",
  "than", "too", "very", "just", "about", "into", "over", "such", "also", "there", "here", "which", "who",
  "whom", "what", "when", "where", "why", "how",
]);

export const textStatsTool: ToolDefinition = {
  name: "text_stats",
  description:
    'Compute statistics for a block of text: character/word/sentence/paragraph counts, estimated reading time, ' +
    'and the most frequent words. Use this for "how many words is this", tweet/character-limit checks, or ' +
    "readability questions — exact and instant, unlike asking the model to count.",
  category: "utility",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to analyze." },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(args: { text: string }) {
    if (typeof args?.text !== "string" || args.text.length === 0) {
      throw new Error("text must be a non-empty string");
    }
    const truncated = args.text.length > MAX_INPUT_CHARS;
    const text = truncated ? args.text.slice(0, MAX_INPUT_CHARS) : args.text;

    const characters = text.length;
    const charactersNoSpaces = text.replace(/\s/g, "").length;
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = text
      .split(/[.!?]+(?:\s|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const lines = text.split("\n").length;

    const freq = new Map<string, number>();
    for (const raw of words) {
      const word = raw.toLowerCase().replace(/[^a-z']/g, "");
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
    const topWords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_WORDS_COUNT)
      .map(([word, count]) => ({ word, count }));

    return {
      analyzedCharacters: characters,
      truncated,
      characters,
      charactersNoSpaces,
      words: words.length,
      sentences: sentences.length,
      paragraphs: paragraphs.length || (text.trim() ? 1 : 0),
      lines,
      averageWordLength: words.length ? Math.round((charactersNoSpaces / words.length) * 100) / 100 : 0,
      estimatedReadingMinutes: Math.max(1, Math.round(words.length / 200)),
      topWords,
    };
  },
};
