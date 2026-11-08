// tracing.ts - manda para o Langfuse tudo o que acontece dentro do grafo: cada carta, cada ferramenta, tokens e tempo
//
// Se não houver chaves LANGFUSE_* no .env, nada é enviado e o bot funciona igual.

import { existsSync } from "node:fs";

import { LangfuseClient } from "@langfuse/client";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// sem .env (worktree nova, CI), as chaves vêm do ambiente: os testes não precisam delas
if (existsSync(import.meta.dirname + "/../.env")) process.loadEnvFile(import.meta.dirname + "/../.env");

const ligado = Boolean(process.env.LANGFUSE_SECRET_KEY);
const provedor = new NodeTracerProvider({ spanProcessors: ligado ? [new LangfuseSpanProcessor()] : [] });
provedor.register();

const cliente = ligado ? new LangfuseClient() : null;

// sessionId junta todas as mensagens de uma conversa; a etiqueta permite filtrar por modelo no painel
export function rastrear(conversa: string, modelo: string) {
	return ligado ? [new CallbackHandler({ sessionId: conversa, tags: [modelo] })] : [];
}

// deixa uma nota na conversa, e ela aparece no painel. Com "certo" falso, o failures.ts traz para a lista do que melhorar.
export function anotar(conversa: string, nome: string, certo: boolean, comentario = "") {
	cliente?.score.create({ sessionId: conversa, name: nome, value: certo ? 1 : 0, dataType: "BOOLEAN", comment: comentario.slice(0, 500) });
}

// os dados saem em lotes: um programa que termina logo precisa mandar o que sobrou antes de fechar
export async function enviarRastreio() {
	await cliente?.flush();
	await provedor.forceFlush();
}
