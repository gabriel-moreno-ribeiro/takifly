// rastreio.ts - manda para o Langfuse tudo o que acontece dentro do grafo: cada carta, cada ferramenta, tokens e tempo
//
// Se não houver chaves LANGFUSE_* no .env, nada é enviado e o bot funciona igual.

import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

process.loadEnvFile(import.meta.dirname + "/../.env");

const ligado = Boolean(process.env.LANGFUSE_SECRET_KEY);
const provedor = new NodeTracerProvider({ spanProcessors: ligado ? [new LangfuseSpanProcessor()] : [] });
provedor.register();

// sessionId junta todas as mensagens de uma conversa; a etiqueta permite filtrar por modelo no painel
export function rastrear(conversa: string, modelo: string) {
	return ligado ? [new CallbackHandler({ sessionId: conversa, tags: [modelo] })] : [];
}

// os dados saem em lotes: um programa que termina logo precisa mandar o que sobrou antes de fechar
export async function enviarRastreio() {
	await provedor.forceFlush();
}
