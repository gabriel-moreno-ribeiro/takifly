// monitor.ts - a rotina que confere os preços sozinha e avisa no Slack
//
// Aqui não tem IA: é código comparando números. Cada checagem não gasta crédito, e o modelo não tem como inventar uma queda de preço.
// O relógio acorda de hora em hora e confere o que está há mais de 6 horas sem checar: assim um Mac que dormiu retoma sozinho.
//
// Para checar uma vez agora, sem Slack (dentro da pasta passagens.ts/):   node harness/monitor.ts

import { atualizarMonitoramento, listarMonitoramentos, type Monitoramento } from "./dados.ts";
import { hojeEmSaoPaulo, descreverMonitoramento, precoAtual } from "./ferramentas.ts";

const INTERVALO_ENTRE_CHECAGENS = 6 * 60 * 60 * 1000;    // 6 horas: a busca não é oficial, e buscar demais pode levar a um bloqueio
const PULSO_DO_RELOGIO = 60 * 60 * 1000;                 // 1 hora
const ESPERA_ENTRE_MONITORAMENTOS = 5000;                // 5 segundos
const FALHAS_ATE_AVISAR = 4;                             // cerca de um dia sem conseguir checar

type Avisar = (conversa: string, texto: string) => Promise<unknown>;

// ---------- CHECAR UM MONITORAMENTO ----------
async function checarUm(monitoramento: Monitoramento, avisar: Avisar, agora: number) {
	const { id, conversa, preco_alvo, menor_preco, avisado_preco } = monitoramento;
	const descricao = descreverMonitoramento(monitoramento);

	// a viagem já passou: não há mais o que monitorar
	if (monitoramento.data < hojeEmSaoPaulo()) {
		await avisar(conversa, `:calendar: Parei de monitorar ${descricao}: a data da viagem já passou.`);
		atualizarMonitoramento(id, { ativo: 0 });
		return;
	}

	let preco;
	try {
		preco = await precoAtual(monitoramento);
	} catch (erro: any) {
		const falhas = monitoramento.falhas + 1;
		console.log(`[monitor] #${id} falhou (${falhas}): ${erro.message}`);
		// falhar calado seria o pior caso: a pessoa acharia que o preço só não baixou
		if (falhas === FALHAS_ATE_AVISAR) await avisar(conversa, `:warning: Não estou conseguindo checar ${descricao} há cerca de um dia (${erro.message}). Continuo tentando.`);
		atualizarMonitoramento(id, { falhas, checado_em: agora });
		return;
	}

	if (preco === null) {
		atualizarMonitoramento(id, { falhas: 0, checado_em: agora });
		return;
	}

	const novoMenor = menor_preco === null ? preco.total : Math.min(menor_preco, preco.total);
	const bomPreco = preco_alvo !== null ? preco.total <= preco_alvo : menor_preco !== null && preco.total < menor_preco;

	// o preço subiu de novo: a próxima queda merece outro aviso
	if (!bomPreco) {
		atualizarMonitoramento(id, { menor_preco: novoMenor, avisado_preco: preco_alvo !== null ? null : avisado_preco, falhas: 0, checado_em: agora });
		return;
	}

	// só avisa se for novidade. Se o Slack falhar, nada é gravado, e a próxima checagem tenta de novo.
	if (avisado_preco === null || preco.total < avisado_preco) {
		const motivo = preco_alvo !== null ? `seu alvo é R$ ${preco_alvo}` : `era R$ ${menor_preco}`;
		const links = [preco.ida.link, preco.volta?.link].filter(Boolean).join("\n");
		await avisar(conversa, `:rotating_light: *Preço bom!* ${descricao}: *R$ ${preco.total}* (${motivo}).\nComprar:\n${links}`);
		atualizarMonitoramento(id, { avisado_preco: preco.total });
	}
	atualizarMonitoramento(id, { menor_preco: novoMenor, falhas: 0, checado_em: agora });
}

// ---------- CHECAR TODOS ----------
export async function checarMonitoramentos(avisar: Avisar, agora = Date.now(), espera = ESPERA_ENTRE_MONITORAMENTOS) {
	const vencidos = listarMonitoramentos().filter((monitoramento) => agora - monitoramento.checado_em >= INTERVALO_ENTRE_CHECAGENS);
	for (const monitoramento of vencidos) {
		try {
			await checarUm(monitoramento, avisar, agora);
		} catch (erro) {
			// o Slack falhou: um monitoramento com problema não pode parar os outros
			console.log(`[monitor] #${monitoramento.id} não conseguiu avisar:`, erro);
		}
		await new Promise((pronto) => setTimeout(pronto, espera));
	}
	return vencidos.length;
}

// ---------- O RELÓGIO ----------
export function ligarMonitor(avisar: Avisar) {
	let rodando = false;    // uma checagem demorada não pode começar por cima da outra
	const pulso = async () => {
		if (rodando) return;
		rodando = true;
		try {
			const quantos = await checarMonitoramentos(avisar);
			if (quantos > 0) console.log(`[monitor] ${quantos} monitoramento(s) checado(s)`);
		} catch (erro) {
			console.log("[monitor] a checagem falhou:", erro);
		}
		rodando = false;
	};
	pulso();
	setInterval(pulso, PULSO_DO_RELOGIO);
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	const quantos = await checarMonitoramentos(async (conversa, texto) => console.log(`[para ${conversa}] ${texto}`));
	console.log(`${quantos} monitoramento(s) checado(s)`);
}
