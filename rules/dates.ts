// dates.ts - o dia de hoje em São Paulo e a soma de dias, as duas contas de data que rules/, sources/ e brain/ usam
//
// Mora em rules/ porque rules/ e sources/ não importam de brain/ (o bloco FRONTEIRAS do quality/tests.ts confere).
// Datas sempre no formato "AAAA-MM-DD".

export function hojeEmSaoPaulo() {
	return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });    // "sv-SE" escreve AAAA-MM-DD
}

export function somarDias(data: string, dias: number) {
	return new Date(new Date(data + "T00:00:00Z").getTime() + dias * 86_400_000).toJSON().slice(0, 10);
}
