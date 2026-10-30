// grafo.ts - passo 15: o menor grafo possível, com um nó só e sem IA
//
// Como rodar (dentro da pasta passagens.ts/):   node grafo.ts

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

// ---------- ESTADO ----------
// a "pasta" que passa pelas etapas: por enquanto ela só guarda um texto
const Estado = Annotation.Root({
	texto: Annotation<string>,
});

// ---------- NÓ ----------
// uma etapa do grafo: recebe a pasta e devolve o que quer mudar nela
function gritar(estado: typeof Estado.State) {
	console.log("Dentro do nó, a pasta tem: " + estado.texto);
	return { texto: estado.texto.toUpperCase() };
}

// ---------- GRAFO ----------
// aqui só desenhamos o caminho: nada roda ainda
const grafo = new StateGraph(Estado)
	.addNode("gritar", gritar)      // cria a etapa, com o nome "gritar"
	.addEdge(START, "gritar")       // seta: do início para "gritar"
	.addEdge("gritar", END)         // seta: de "gritar" para o fim
	.compile();                     // confere o desenho e deixa o grafo pronto para rodar

// ---------- RODAR ----------
const resultado = await grafo.invoke({ texto: "quero ir para lisboa" });
console.log("No fim, a pasta tem: " + resultado.texto);
