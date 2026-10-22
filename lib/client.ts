import Anthropic from "@anthropic-ai/sdk";

let instance: Anthropic | undefined;

// Created on first use so the server can start, and explain what's missing, without credentials.
export function anthropic(): Anthropic {
  instance ??= new Anthropic({ maxRetries: 4 });
  return instance;
}
