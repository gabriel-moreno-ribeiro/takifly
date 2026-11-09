// rules.ts - confere as regras de uma viagem: passaporte, visto, vacina, menor, conexão, bagagem, câmbio
//
// É o item 4 do docs/AGENCIA.md, e é código puro: nenhuma regra daqui precisa de IA, de internet ou de banco.
// O arquivo devolve a lista do que está errado; quem explica para a pessoa é o redator.
//
// Duas combinações importam na saída:
//   "impede"  = a viagem não acontece desse jeito (passaporte vencido, visto que falta)
//   "atencao" = a pessoa precisa saber antes de comprar (ETA, franquia que pode zerar, IOF)
//
// Nenhuma regra pode derrubar o nó: quando falta um dado, vira "atencao" em vez de erro.

import { hojeEmSaoPaulo, somarDias } from "./dates.ts";
import { paisDoAeroporto } from "./airports.ts";
import { VISTO, FEBRE_AMARELA } from "./rules-data.ts";

// o país de um aeroporto mora no airports.ts, mas quem chama vem buscar aqui: o nó do grafo importa
// todas as regras de viagem de um lugar só.
export { paisDoAeroporto };

export type Viajante = {
	nacionalidade: string;           // "BR" por padrão
	passaporte_validade?: string;    // "AAAA-MM-DD"
	nascimento?: string;             // para a regra de menor de idade
	acompanhantes?: "pai" | "mae" | "os-dois" | "sozinho" | "outro";
	vacina_febre_amarela?: string;   // data da dose
};

export type Trecho = {
	origem: string;                  // IATA, ex "GRU"
	destino: string;                 // IATA
	partida: string;                 // "AAAA-MM-DDTHH:MM"
	chegada: string;
	companhia?: string;
	bagagem_despachada?: number;     // peças incluídas, se a busca souber
	bilhete_separado?: boolean;      // trecho comprado num bilhete à parte
};

export type Viagem = {
	viajantes: Viajante[];
	trechos: Trecho[];               // na ordem, ida e volta juntas
	pais_destino: string;            // "PT", "US", ...
	motivo?: "turismo" | "trabalho" | "estudo";
	dias_de_permanencia?: number;
};

export type Aviso = {
	regra: string;                      // "passaporte", "visto", ...
	gravidade: "impede" | "atencao";    // impede = a viagem não acontece; atencao = a pessoa precisa saber
	texto: string;                      // em português, pronto para o redator explicar
};

// ---------- AS TABELAS ----------
// As duas tabelas grandes - visto e febre amarela - não estão escritas aqui: elas são BAIXADAS de uma
// fonte citada pelo rules/update-rules-data.ts, que grava o rules/rules-data.ts. Dizer "pode
// viajar" errado é o pior erro que este arquivo pode cometer, então nenhuma linha dessas tabelas é
// escrita de cabeça. Cada tabela carrega de onde veio (fonte) e de quando é (conferido_em), e os avisos
// repetem essa data para a pessoa saber que a regra pode ter mudado depois.
//
// O que não está na tabela nunca é chutado: vira "atencao" para confirmar no consulado.

// países que exigem visto de quem só troca de avião, sem nem passar pela imigração.
// Esta é a única lista escrita à mão, porque a página de visto não tem coluna de trânsito.
// shortcut: só as fronteiras que o bot pesquisa hoje; conexão em país fora desta lista é tratada como trânsito livre — reveja quando a busca trouxer conexão na Ásia ou na África
const VISTO_EM_TRANSITO = {
	fonte: "travel.state.gov (EUA: trânsito pede visto C-1, não existe trânsito livre), canada.ca (Canadá: trânsito pede visto ou eTA) e a nota do México na mesma página da Wikipedia (o eVisa mexicano vale também para quem só passa pelo aeroporto)",
	conferido_em: "2026-11-02",
	paises: ["US", "PR", "VI", "GU", "MP", "AS", "CA", "MX"],    // os territórios americanos usam a imigração dos EUA
};

const DIAS_DE_ANTECEDENCIA_DA_VACINA = 10;

// tempo mínimo entre a chegada de um trecho e a partida do próximo
// shortcut: um número só para qualquer aeroporto; GRU e CDG com troca de terminal pedem mais — melhorar quando a busca trouxer o terminal
const MINUTOS_DE_CONEXAO = { domestico: 45, internacional: 90, bilhete_separado: 180 };

const IOF_CARTAO = 0.035;    // 3,5% em compra internacional no cartão de crédito

// ---------- CONTINHAS DE DATA ----------
// a data vem sempre em AAAA-MM-DD ou AAAA-MM-DDTHH:MM, então dá para comparar como texto; só somar precisa de Date
function somarMeses(data: string, meses: number) {
	const dia = new Date(data.slice(0, 10) + "T00:00:00Z");
	dia.setUTCMonth(dia.getUTCMonth() + meses);
	return dia.toJSON().slice(0, 10);
}

// os dois horários de uma conexão são do mesmo aeroporto, então subtrair direto dá o tempo certo
function minutosEntre(chegada: string, partida: string) {
	return (Date.parse(partida + ":00Z") - Date.parse(chegada + ":00Z")) / 60_000;
}

function emReais(valor: number) {
	return "R$ " + valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function paraBrasileiro(data: string) {
	const [ano, mes, dia] = data.slice(0, 10).split("-");
	return `${dia}/${mes}/${ano}`;
}

// todo aviso que vem de tabela diz de quando é o dado, porque regra de fronteira muda sem avisar.
// Quando a fonte tem data própria, é ela que vale: o anexo da OMS é de janeiro de 2023, e dizer
// "minha tabela é de hoje" só porque hoje foi o dia do download esconderia um dado de anos atrás.
function deQuando(tabela: { conferido_em: string; publicado_em?: string }) {
	return ` (dado de ${tabela.publicado_em ?? paraBrasileiro(tabela.conferido_em)})`;
}

// ---------- AS SETE REGRAS ----------
export function conferirViagem(viagem: Viagem, hoje = hojeEmSaoPaulo(), valorEmReaisNoCartao?: number): Aviso[] {
	const avisos: Aviso[] = [];
	const anotar = (regra: string, gravidade: "impede" | "atencao", texto: string) => avisos.push({ regra, gravidade, texto });

	const ida = viagem.trechos[0];
	const volta = viagem.trechos.at(-1);
	if (!ida || !volta) {
		anotar("trechos", "atencao", "não recebi nenhum trecho de voo, então não consegui conferir nenhuma regra desta viagem.");
		return avisos;
	}
	const dataDaIda = ida.partida.slice(0, 10);
	const dataDaVolta = volta.chegada.slice(0, 10);

	// 1. PASSAPORTE: a validade tem que ir até 6 meses depois da volta
	const validadeMinima = somarMeses(dataDaVolta, 6);
	for (const viajante of viagem.viajantes) {
		if (!viajante.passaporte_validade) {
			anotar("passaporte", "atencao", `não tenho a validade do passaporte no cadastro, então não deu para conferir. Confirme que ele vence depois de ${paraBrasileiro(validadeMinima)}.`);
		} else if (viajante.passaporte_validade < dataDaVolta) {
			anotar("passaporte", "impede", `o passaporte vence em ${paraBrasileiro(viajante.passaporte_validade)}, antes da volta em ${paraBrasileiro(dataDaVolta)}. Precisa renovar antes de viajar.`);
		} else if (viajante.passaporte_validade < validadeMinima) {
			anotar("passaporte", "impede", `quase toda fronteira exige passaporte válido por 6 meses depois da volta, ou seja até ${paraBrasileiro(validadeMinima)}. O seu vence em ${paraBrasileiro(viajante.passaporte_validade)}: renove antes de comprar.`);
		}
	}

	// 2. VISTO: conta o destino final e também cada conexão
	const diasNoDestino = viagem.dias_de_permanencia ?? Math.round(minutosEntre(ida.partida, volta.chegada) / 1440);
	const paisesDeConexao = [...new Set(viagem.trechos.slice(0, -1).map((trecho) => paisDoAeroporto(trecho.destino)))];

	for (const viajante of viagem.viajantes) {
		if (viajante.nacionalidade !== "BR") {
			anotar("visto", "atencao", `minha tabela de visto é só para passaporte brasileiro, e este é ${viajante.nacionalidade}. Confirme no consulado.`);
			continue;
		}

		const destino = VISTO.paises[viagem.pais_destino];
		if (!destino) {
			anotar("visto", "atencao", `não tenho ${viagem.pais_destino} na minha tabela de visto. Confirme no consulado antes de comprar.`);
		} else if (destino.exige === "antes") {
			anotar("visto", "impede", `${destino.nome} exige visto de brasileiro, tirado antes de viajar. Sem o visto na mão, o embarque é negado${deQuando(VISTO)}.`);
		} else if (destino.exige === "evisa") {
			anotar("visto", "impede", `${destino.nome} exige visto de brasileiro. Ele é pedido pela internet (eVisa), mas precisa estar aprovado antes do embarque${deQuando(VISTO)}.`);
		} else if (destino.exige === "na-chegada") {
			anotar("visto", "atencao", `${destino.nome} exige visto de brasileiro, e ele é emitido na chegada, no balcão da fronteira. Leve o dinheiro da taxa e confirme no consulado o que pedem${deQuando(VISTO)}.`);
		} else {
			// isento: o que pode dar errado é ficar mais tempo do que a isenção cobre, ou não ser turismo
			if (destino.dias !== undefined && diasNoDestino > destino.dias) {
				anotar("visto", "atencao", `brasileiro entra em ${destino.nome} sem visto por até ${destino.dias} dias, e esta viagem tem ${diasNoDestino}. Para ficar mais tempo, precisa de autorização de residência ou visto.`);
			}
			if (viagem.motivo === "trabalho" || viagem.motivo === "estudo") {
				anotar("visto", "atencao", `a isenção de visto de ${destino.nome} é para turismo. Como a viagem é de ${viagem.motivo}, confirme no consulado se o seu caso precisa de visto.`);
			}
		}
		if (destino?.nota) anotar("visto", "atencao", `${destino.nome}: ${destino.nota}.`);

		// a conexão é o caso que o docs/AGENCIA.md cita: nos EUA precisa de visto mesmo sem sair do aeroporto
		for (const pais of paisesDeConexao) {
			if (pais === "") continue;    // aeroporto que não está na tabela: avisado na regra de conexão
			if (pais === "BR" || pais === viagem.pais_destino) continue;
			const escala = VISTO.paises[pais];
			if (VISTO_EM_TRANSITO.paises.includes(pais)) {
				const nome = escala?.nome ?? pais;
				anotar("visto", "impede", `a conexão é em ${nome}, e brasileiro precisa de visto para ${nome} mesmo só trocando de avião, sem sair do aeroporto.`);
			} else if (!escala) {
				anotar("visto", "atencao", `a viagem faz conexão em ${pais} e eu não tenho esse país na tabela de visto. Confirme no consulado se a conexão exige algo.`);
			}
		}
	}

	// 3. VACINA: a dose de febre amarela vale 10 dias depois de tomada
	const vacinaObrigatoria = FEBRE_AMARELA.paises[viagem.pais_destino];
	if (vacinaObrigatoria) {
		for (const viajante of viagem.viajantes) {
			if (!viajante.vacina_febre_amarela) {
				// sem a dose no cadastro, o que muda é se ainda dá tempo de tomar
				const ultimoDia = somarDias(dataDaIda, -DIAS_DE_ANTECEDENCIA_DA_VACINA);
				if (hoje > ultimoDia) {
					anotar("vacina", "impede", `${vacinaObrigatoria} exige o certificado de febre amarela de quem chega do Brasil, não tenho a dose no cadastro e o prazo já passou: ela precisava ser tomada até ${paraBrasileiro(ultimoDia)}, ${DIAS_DE_ANTECEDENCIA_DA_VACINA} dias antes do embarque${deQuando(FEBRE_AMARELA)}.`);
				} else {
					anotar("vacina", "atencao", `${vacinaObrigatoria} exige o certificado de febre amarela de quem chega do Brasil, e não tenho a dose no cadastro. Se ainda não tomou, dá tempo: tome até ${paraBrasileiro(ultimoDia)}${deQuando(FEBRE_AMARELA)}.`);
				}
			} else if (somarDias(viajante.vacina_febre_amarela, DIAS_DE_ANTECEDENCIA_DA_VACINA) > dataDaIda) {
				anotar("vacina", "impede", `a dose de febre amarela é de ${paraBrasileiro(viajante.vacina_febre_amarela)} e só passa a valer ${DIAS_DE_ANTECEDENCIA_DA_VACINA} dias depois, mas o embarque para ${vacinaObrigatoria} é em ${paraBrasileiro(dataDaIda)}${deQuando(FEBRE_AMARELA)}.`);
			}
		}
	}

	// 4. MENOR DE IDADE: sozinho ou com um dos pais precisa de autorização
	for (const viajante of viagem.viajantes) {
		const precisaDeAutorizacao = viajante.acompanhantes === "sozinho" || viajante.acompanhantes === "pai" || viajante.acompanhantes === "mae" || viajante.acompanhantes === "outro";
		if (!precisaDeAutorizacao) continue;
		if (!viajante.nascimento) {
			anotar("menor", "atencao", "não tenho a data de nascimento no cadastro. Se o viajante tiver menos de 16 anos, a viagem exige autorização dos pais.");
			continue;
		}
		const dataDos16Anos = somarMeses(viajante.nascimento, 16 * 12);
		if (dataDos16Anos > dataDaIda) {
			const quem = viajante.acompanhantes === "sozinho" ? "viajando sozinho" : viajante.acompanhantes === "outro" ? "viajando com quem não é o pai nem a mãe" : viajante.acompanhantes === "pai" ? "viajando só com o pai" : "viajando só com a mãe";
			const deQuem = viajante.acompanhantes === "pai" ? "da mãe" : viajante.acompanhantes === "mae" ? "do pai" : "dos dois pais";
			anotar("menor", "atencao", `o viajante tem menos de 16 anos e está ${quem}: precisa da autorização ${deQuem}, assinada em cartório ou pelo site do CNJ.`);
		}
	}

	// 5. CONEXÃO: tempo mínimo entre a chegada de um trecho e a partida do próximo
	for (let i = 0; i < viagem.trechos.length - 1; i++) {
		const chega = viagem.trechos[i];
		const parte = viagem.trechos[i + 1];
		if (chega.destino !== parte.origem) continue;    // não é conexão: a pessoa fica na cidade

		const minutos = minutosEntre(chega.chegada, parte.partida);
		if (minutos > 1440) continue;    // mais de um dia parado no mesmo aeroporto não é conexão, é a estadia

		const paisDaEscala = paisDoAeroporto(chega.destino);
		if (paisDaEscala === "") {
			anotar("conexao", "atencao", `não conheço o aeroporto ${chega.destino}, então usei o tempo de conexão internacional para conferir. Confirme o terminal.`);
		}
		const domestico = paisDaEscala === "BR" && paisDoAeroporto(parte.destino) === "BR";
		const separado = chega.bilhete_separado || parte.bilhete_separado;
		const minimo = separado ? MINUTOS_DE_CONEXAO.bilhete_separado : domestico ? MINUTOS_DE_CONEXAO.domestico : MINUTOS_DE_CONEXAO.internacional;

		if (minutos < minimo) {
			if (separado) {
				anotar("conexao", "atencao", `a conexão em ${chega.destino} tem ${minutos} minutos e os trechos estão em bilhetes separados, então eu pediria ${minimo}. Se o primeiro voo atrasar, a companhia do segundo não tem obrigação nenhuma: o prejuízo é seu.`);
			} else {
				anotar("conexao", "impede", `a conexão em ${chega.destino} tem só ${minutos} minutos, e o mínimo ${domestico ? "doméstico" : "internacional"} é ${minimo}. Não dá tempo.`);
			}
		} else if (separado) {
			anotar("conexao", "atencao", `os trechos da conexão em ${chega.destino} estão em bilhetes separados. O tempo dá, mas se o primeiro voo atrasar a companhia do segundo não tem obrigação nenhuma: o prejuízo é seu.`);
		}
	}

	// 6. BAGAGEM: trecho sem franquia junto de trecho com franquia
	const comFranquia = viagem.trechos.filter((trecho) => (trecho.bagagem_despachada ?? 0) > 0);
	const semFranquia = viagem.trechos.filter((trecho) => !(trecho.bagagem_despachada ?? 0));
	if (comFranquia.length > 0 && semFranquia.length > 0) {
		const trechos = semFranquia.map((trecho) => `${trecho.origem}→${trecho.destino}`).join(", ");
		anotar("bagagem", "atencao", `a mala despachada está incluída em parte da viagem, mas não no trecho ${trechos}. Quando o trecho é de outra companhia, a franquia pode zerar e a bagagem é cobrada no aeroporto.`);
	}

	// 7. CÂMBIO: se ninguém passou o valor, a regra fica calada de propósito
	if (valorEmReaisNoCartao != null) {
		const iof = valorEmReaisNoCartao * IOF_CARTAO;
		anotar("cambio", "atencao", `compra internacional no cartão de crédito tem IOF de 3,5%: sobre ${emReais(valorEmReaisNoCartao)} dá ${emReais(iof)}, então o total fica ${emReais(valorEmReaisNoCartao + iof)}.`);
	}

	// o redator lê de cima para baixo: primeiro o que impede a viagem
	return avisos.sort((a, b) => Number(a.gravidade === "atencao") - Number(b.gravidade === "atencao"));
}

// ---------- AS REGRAS DE ENTRADA DE UM PAÍS ----------
// A pergunta solta ("brasileiro precisa de visto para o Japão?"), sem viagem montada: a resposta vem da mesma
// tabela que o conferirViagem usa, e não de um site. Visto é regra, e regra é código. Devolve null se o país
// não está na tabela; aí quem pergunta busca na internet.
const EM_INGLES = new Intl.DisplayNames(["en"], { type: "region" });
const semAcentoNem = (texto: string) => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z]/g, "");

// como a pessoa escreve e a tabela não tem
const APELIDOS: Record<string, string> = { eua: "US", usa: "US", inglaterra: "GB", escocia: "GB", holanda: "NL" };

export function regrasDeEntrada(pais: string) {
	const procurado = semAcentoNem(pais);
	if (APELIDOS[procurado]) return regrasDeEntrada(APELIDOS[procurado]);
	const codigo = Object.keys(VISTO.paises).find((sigla) => [sigla, VISTO.paises[sigla].nome, EM_INGLES.of(sigla) ?? ""].some((nome) => semAcentoNem(nome) === procurado));
	if (!codigo) return null;
	const { nome, exige, dias, nota } = VISTO.paises[codigo];
	const visto = {
		isento: `não precisa de visto para turismo${dias ? `, até ${dias} dias` : ""}`,
		"na-chegada": "o visto se resolve na chegada, no balcão da fronteira",
		evisa: "precisa de visto eletrônico, pedido pela internet e aprovado antes de embarcar",
		antes: "precisa de visto tirado no consulado antes de viajar",
	}[exige];
	const vacina = FEBRE_AMARELA.paises[codigo]
		? "exige o certificado internacional de vacina contra febre amarela de quem chega do Brasil"
		: "não está na lista da OMS de países que exigem a vacina de febre amarela de quem vem do Brasil";
	return [
		`${nome}, para passaporte brasileiro: ${visto}${nota ? ` (${nota})` : ""}.`,
		`Febre amarela: ${vacina}.`,
		`Fontes: ${VISTO.fonte}, conferida em ${VISTO.conferido_em}; ${FEBRE_AMARELA.fonte}. Regra de entrada muda: vale confirmar no consulado antes de viajar.`,
	].join("\n");
}
