// grafo.ts - passo 15: o menor grafo possível, com um nó só e sem IA
//
// Como rodar (dentro da pasta passagens.ts/):   node grafo.ts

import { writeFile } from "node:fs/promises";

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

// ---------- DESENHAR ----------
// o LangGraph descreve o grafo em Mermaid, uma linguagem de desenhos feita de texto
const desenho = await grafo.getGraphAsync();
const textoDoDesenho = desenho.drawMermaid();
console.log("\nO grafo escrito em Mermaid:\n" + textoDoDesenho);

// grafo.html é uma página que baixa o programa Mermaid e desenha aí no seu navegador (nada do grafo sai do Mac)
const pagina = `<!doctype html>
<meta charset="utf-8">
<title>Grafo</title>
<pre class="mermaid">${textoDoDesenho}</pre>
<script type="module">
	import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
	mermaid.initialize({ startOnLoad: true });
</script>`;
await writeFile("grafo.html", pagina);
console.log("Desenho salvo em grafo.html");
