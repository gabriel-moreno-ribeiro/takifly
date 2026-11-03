// planilha_viva.gs - cole este código no Apps Script da planilha "Bot de Passagens - valores"
//
// ============================================================================
// COMO REIMPLANTAR (você precisa fazer isto à mão, na sua conta do Google)
// ============================================================================
// Este arquivo mudou: antes ele só sabia CRIAR planilha nova, agora também sabe ATUALIZAR uma que já existe.
// Enquanto você não reimplantar, o monitor vai criar uma planilha nova a cada checagem. Passo a passo:
//
//  1. Abra a planilha "Bot de Passagens - valores" no Google Sheets.
//  2. Menu "Extensões" > "Apps Script". Abre o editor de código numa aba nova.
//  3. Apague TODO o código que está lá e cole TODO o conteúdo deste arquivo (planilha_viva.gs).
//  4. Clique no ícone de salvar (o disquete) ou aperte Cmd+S.
//  5. Botão azul "Implantar" (canto superior direito) > "Gerenciar implantações".
//  6. Na implantação que já existe, clique no lápis (ícone de editar, em cima à direita do painel).
//  7. No campo "Versão", troque "Versão 1" (ou a que estiver) por "Nova versão".
//  8. Confira que "Executar como" está em "Eu" e "Quem pode acessar" em "Qualquer pessoa".
//  9. Clique em "Implantar". Se o Google pedir autorização, aceite (ele vai pedir de novo porque o
//     código agora também abre planilhas que já existem, e não só cria).
// 10. Copie a "URL do app da Web" que aparece.
// 11. IMPORTANTE: se essa URL for DIFERENTE da que está no seu .env, abra o arquivo .env e troque o
//     valor de PLANILHA_VIVA_URL pela URL nova, e reinicie o bot (node bot.ts).
//     Seguindo os passos 5-7 ("Gerenciar implantações" + "Nova versão") a URL costuma ficar a MESMA.
//     Ela só muda se você usar "Implantar" > "Nova implantação", que cria outro endereço.
//
// Para testar sem o bot: no editor do Apps Script, aba "Execuções", você vê cada chamada que chegou.
// ============================================================================
//
// O bot manda um POST de dois jeitos:
//
//   CRIAR (a pesquisa do bot, o que já existia):
//     {"titulo": "Passagens - GRU para Lisboa - 29/10 14:30",
//      "abas": [{"nome": "Voos", "colunas": [...], "linhas": [[...]]}]}
//
//   ATUALIZAR (o monitor, a cada 2 horas): igual, mais o campo "planilha" (o link ou o id da planilha)
//   e um "modo" em cada aba:
//     {"titulo": "Monitor #3 - GRU→LIS",
//      "planilha": "https://docs.google.com/spreadsheets/d/....",
//      "abas": [{"nome": "Histórico", "modo": "acrescentar", "colunas": [...], "linhas": [[...]]},
//               {"nome": "Resumo", "modo": "reescrever", "colunas": [...], "linhas": [[...]]}]}
//
// Nos dois casos ele recebe de volta {"ok": true, "link": "https://docs.google.com/spreadsheets/d/..."}.
// Quem manda "planilha" vazio (ou nem manda) cai no modo criar: é assim que o monitor ganha a primeira
// planilha dele sem precisar de um passo separado.
// Todas as planilhas ficam numa pasta "Bot de Passagens" no seu Drive.

var PASTA = "Bot de Passagens";

function doPost(e) {
  var pedido = JSON.parse(e.postData.contents);
  var link = pedido.planilha ? atualizar(pedido) : criar(pedido);
  return ContentService.createTextOutput(JSON.stringify({ ok: true, link: link }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- MODO CRIAR ----------
function criar(pedido) {
  var nova = SpreadsheetApp.create(pedido.titulo);
  var vazia = nova.getSheets()[0];      // toda planilha nova vem com uma aba vazia; apagamos no fim

  pedido.abas.forEach(function (definicao) {
    if (definicao.linhas.length === 0) return;
    var aba = nova.insertSheet(definicao.nome);
    cabecalho(aba, definicao);
    aba.getRange(2, 1, definicao.linhas.length, definicao.colunas.length).setValues(definicao.linhas);
    // o filtro só dá para criar uma vez por aba, então ele fica só no modo criar
    aba.getRange(1, 1, definicao.linhas.length + 1, definicao.colunas.length).createFilter();
    enfeitar(aba, definicao, 2);
  });
  if (nova.getSheets().length > 1) nova.deleteSheet(vazia);

  // guarda na pasta "Bot de Passagens" (cria a pasta na primeira vez)
  var pastas = DriveApp.getFoldersByName(PASTA);
  var pasta = pastas.hasNext() ? pastas.next() : DriveApp.createFolder(PASTA);
  DriveApp.getFileById(nova.getId()).moveTo(pasta);

  return nova.getUrl();
}

// ---------- MODO ATUALIZAR ----------
// "acrescentar" empurra as linhas para o fim da aba (o histórico de preço cresce para baixo).
// "reescrever" limpa a aba e põe só estas linhas (o resumo mostra sempre o estado de agora).
function atualizar(pedido) {
  var planilha = abrir(pedido.planilha);

  pedido.abas.forEach(function (definicao) {
    if (definicao.linhas.length === 0) return;
    var aba = planilha.getSheetByName(definicao.nome);
    var nova = !aba;
    if (nova) aba = planilha.insertSheet(definicao.nome);
    if (definicao.modo === "reescrever") aba.clear();
    if (nova || definicao.modo === "reescrever" || aba.getLastRow() === 0) cabecalho(aba, definicao);

    var primeira = aba.getLastRow() + 1;
    aba.getRange(primeira, 1, definicao.linhas.length, definicao.colunas.length).setValues(definicao.linhas);
    enfeitar(aba, definicao, primeira);
  });

  return planilha.getUrl();
}

// o bot pode mandar o link inteiro ou só o id: o id é o pedaço comprido no meio do link
function abrir(ondeEsta) {
  var achado = String(ondeEsta).match(/[-\w]{25,}/);
  return SpreadsheetApp.openById(achado ? achado[0] : String(ondeEsta));
}

// ---------- ENFEITES ----------
function cabecalho(aba, definicao) {
  aba.getRange(1, 1, 1, definicao.colunas.length).setValues([definicao.colunas])
    .setFontWeight("bold").setFontColor("#ffffff").setBackground("#1c4f8f");
  aba.setFrozenRows(1);
}

function enfeitar(aba, definicao, primeira) {
  var largura = definicao.colunas.length;

  // as colunas de preço em reais (no "Hotel, carro e mais" o preço é texto, ex: "€ 35/dia")
  var colunasDePreco = ["preco", "mais_barato", "melhor_custo_beneficio", "mais_rapido", "custo_beneficio", "preco_alvo", "menor_preco", "preco_ida", "preco_volta"];
  if (definicao.nome !== "Hotel, carro e mais") {
    colunasDePreco.forEach(function (nome) {
      var coluna = definicao.colunas.indexOf(nome) + 1;
      if (coluna > 0) aba.getRange(primeira, coluna, definicao.linhas.length, 1).setNumberFormat('"R$" #,##0');
    });
  }
  // com alvo (rotina): verde = dentro do alvo, vermelho = acima. Sem alvo: o mais barato em verde
  var colunaAlvo = definicao.colunas.indexOf("dentro_do_alvo");
  if (colunaAlvo >= 0) {
    definicao.linhas.forEach(function (linha, i) {
      aba.getRange(primeira + i, 1, 1, largura).setBackground(linha[colunaAlvo] === "sim" ? "#d9f0d3" : "#fbe0de");
    });
  } else if (definicao.colunas.indexOf("companhia") === 0 && primeira === 2) {
    aba.getRange(2, 1, 1, largura).setBackground("#d9f0d3");
  }
  aba.autoResizeColumns(1, largura);
}
