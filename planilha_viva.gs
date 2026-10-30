// planilha_viva.gs - cole este código no Apps Script da planilha "Bot de Passagens - valores"
// (Extensões > Apps Script)
//
// Ele vira um "endereço" na internet que cria uma PLANILHA NOVA para cada pesquisa do bot.
// O bot manda um POST assim:
//   {"titulo": "Passagens - GRU para Lisboa - 29/10 14:30",
//    "abas": [{"nome": "Voos", "colunas": [...], "linhas": [[...], [...]]}, ...]}
// e recebe de volta {"ok": true, "link": "https://docs.google.com/spreadsheets/d/..."}.
// Todas as planilhas ficam numa pasta "Bot de Passagens" no seu Drive.

var PASTA = "Bot de Passagens";

function doPost(e) {
  var pedido = JSON.parse(e.postData.contents);
  var nova = SpreadsheetApp.create(pedido.titulo);
  var vazia = nova.getSheets()[0];      // toda planilha nova vem com uma aba vazia; apagamos no fim

  pedido.abas.forEach(function (definicao) {
    if (definicao.linhas.length === 0) return;
    var aba = nova.insertSheet(definicao.nome);
    var largura = definicao.colunas.length;
    aba.getRange(1, 1, 1, largura).setValues([definicao.colunas])
      .setFontWeight("bold").setFontColor("#ffffff").setBackground("#1c4f8f");
    aba.getRange(2, 1, definicao.linhas.length, largura).setValues(definicao.linhas);
    aba.setFrozenRows(1);
    aba.getRange(1, 1, definicao.linhas.length + 1, largura).createFilter();

    // as colunas de preço em reais (no "Hotel, carro e mais" o preço é texto, ex: "€ 35/dia")
    var colunasDePreco = ["preco", "mais_barato", "melhor_custo_beneficio", "mais_rapido", "custo_beneficio", "preco_alvo"];
    if (definicao.nome !== "Hotel, carro e mais") {
      colunasDePreco.forEach(function (nome) {
        var coluna = definicao.colunas.indexOf(nome) + 1;
        if (coluna > 0) aba.getRange(2, coluna, definicao.linhas.length, 1).setNumberFormat('"R$" #,##0');
      });
    }
    // com alvo (rotina): verde = dentro do alvo, vermelho = acima. Sem alvo: o mais barato em verde
    var colunaAlvo = definicao.colunas.indexOf("dentro_do_alvo");
    if (colunaAlvo >= 0) {
      definicao.linhas.forEach(function (linha, i) {
        aba.getRange(i + 2, 1, 1, largura).setBackground(linha[colunaAlvo] === "sim" ? "#d9f0d3" : "#fbe0de");
      });
    } else if (definicao.colunas.indexOf("companhia") === 0) {
      aba.getRange(2, 1, 1, largura).setBackground("#d9f0d3");
    }
    aba.autoResizeColumns(1, largura);
  });
  if (nova.getSheets().length > 1) nova.deleteSheet(vazia);

  // guarda na pasta "Bot de Passagens" (cria a pasta na primeira vez)
  var pastas = DriveApp.getFoldersByName(PASTA);
  var pasta = pastas.hasNext() ? pastas.next() : DriveApp.createFolder(PASTA);
  DriveApp.getFileById(nova.getId()).moveTo(pasta);

  return ContentService.createTextOutput(JSON.stringify({ ok: true, link: nova.getUrl() }))
    .setMimeType(ContentService.MimeType.JSON);
}
