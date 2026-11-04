# Escalação

Escalação de futebol e tierlist no mesmo site, com suas próprias fotos, imagens da web e elementos só de texto, contas por e-mail e uma aba Comunidade.

## Como rodar

Precisa do Node 18 ou mais novo. Não há nada para instalar.

```
node server.js
```

Abra http://localhost:3000

No Windows, se o PowerShell bloquear o `npm`, rode direto `node server.js`.

O servidor serve o site, guarda as contas e a comunidade e faz a ponte com os bancos de imagens. Abrir o `index.html` direto no navegador não funciona.

## Tela inicial

- **Escalação de futebol:** campo com posições; use fotos ou elementos de texto.
- **Tierlist:** escolha um modelo pronto ou comece do zero.
- **Comunidade:** tierlists publicadas por outras pessoas.
- **Minhas listas:** tudo o que você salvou. Abra, duplique ou exclua.

## Modelos de tierlist

Filmes, Séries, Animes, Jogos, Comida, Bandas e artistas e Super-heróis. Todos vêm só com texto (20 elementos coloridos na área "Sem tier"); as imagens você adiciona depois, manualmente ou pela busca. Os tiers têm nomes do tema. Você pode renomear os tiers, mudar as cores, reordenar, excluir, adicionar tiers e adicionar seus próprios itens. "Do zero" abre S, A, B, C e D vazios.

## Salvar e conta

Sem conta, cada lista é salva só neste navegador (automaticamente a cada mudança; o botão **Salvar** confirma na hora). Trocar de navegador ou limpar os dados do site apaga tudo.

Com conta (**Criar conta** / **Entrar**, por e-mail e senha), as listas e as fotos enviadas são guardadas no servidor e aparecem em qualquer aparelho. A sincronização é automática; o estado aparece como "Salvo na conta ✓".

- As listas feitas antes de criar a conta são enviadas para ela no primeiro login.
- Se duas telas editam ao mesmo tempo, vale a versão mais recente de cada lista.
- **Sair** apaga a cópia local do navegador (os dados continuam na conta). **Excluir conta** apaga tudo do servidor.
- Senhas são guardadas com scrypt (nunca em texto), a sessão usa cookie HttpOnly e há limite de tentativas de login.
- Listas do antigo modo "Escalação de jogos" viram escalações de futebol; os jogos da Steam viram elementos de texto.
- Ainda não há "esqueci minha senha" nem confirmação por e-mail: isso exige um serviço de envio de e-mails.

## Comunidade

Com a conta ativa, abra uma tierlist e clique em **Publicar na comunidade**: ela aparece, com as fotos, na aba Comunidade, com o nome que você escolher (o e-mail nunca aparece). Publicar de novo a mesma lista atualiza a publicação. Na Comunidade, **Usar como modelo** abre uma cópia sua, **Retirar** tira a sua publicação e **Denunciar** esconde uma tierlist depois de 3 denúncias de pessoas diferentes. Limites: 30 publicações por conta, 300 itens e cerca de 3,5 MB de fotos por tierlist. Defina `ADMIN_EMAIL` no servidor para que esse e-mail possa retirar qualquer publicação.

## Como usar o editor

- Fontes de itens: **Fotos** (suas imagens), **Imagens** (busca em bancos livres, por exemplo "comida") e o formulário **Novo elemento** da tierlist: escreva o texto (vários separados por vírgula), escolha a cor de fundo e clique em Adicionar elemento.
- Clique em um item ou arraste até uma vaga ou tier. Nos campos, a seleção avança sozinha para a próxima vaga livre.
- Campos: no painel da direita, **Elemento só de texto** cria um nome escrito (com a cor de fundo que você escolher). Fotos e imagens funcionam igual: com uma vaga marcada o item entra nela; sem vaga marcada vai para **Sem posição**, abaixo do campo. De lá você arrasta até a vaga (ou clica no elemento para colocá-lo na vaga marcada ou na primeira livre), e arrasta um jogador do campo de volta para lá. Arraste a foto ou o ícone vazio para mover o jogador livremente (setas do teclado também). "Resetar posições" volta à formação. Solte sobre o técnico ou um reserva para trocar, ou sobre o painel para remover.
- Tierlist: clique na área de um tier para marcá-lo; os próximos itens vão para ele. Sem tier marcado, vão para "Sem tier". Arraste os itens entre tiers. "Mostrar nomes" exibe o nome sob cada item.
- Fotos: botão "Adicionar fotos", Ctrl+V para colar, ou solte arquivos no painel, numa vaga ou num tier.
- "Baixar imagem" gera um PNG para compartilhar.

## Imagens da web

Vêm de bancos livres (Openverse e Wikimedia Commons). A busca em português é traduzida para inglês antes. A maioria das licenças é Creative Commons: para uso pessoal não há problema, mas para publicar confira o crédito mostrado na aba Fotos. O servidor só baixa imagens desses dois bancos.

## Publicar online

O site é um servidor Node (`node server.js`, porta na variável `PORT`) e guarda as contas em arquivos na pasta `DATA_DIR` (padrão `./data`). **Essa pasta precisa ficar em armazenamento persistente**; em hospedagem com disco temporário, as contas somem a cada reinício.

Variáveis de ambiente:

| Variável | Para quê |
| --- | --- |
| `PORT` | porta (a hospedagem costuma definir sozinha) |
| `DATA_DIR` | pasta das contas e listas, num disco/volume persistente (ex.: `/data`) |
| `TRUST_PROXY=1` | atrás de proxy HTTPS (quase toda hospedagem): usa o IP real e marca o cookie como `Secure` |

O projeto inclui um `Dockerfile` (volume em `/data`) e responde em `/healthz` para o teste de saúde. Passos gerais em Render, Railway, Fly.io ou um VPS:

1. Suba a pasta para um repositório no GitHub (o `.gitignore` já exclui `data/`).
2. Crie um serviço Web a partir do repositório (usando o Dockerfile, ou comando `node server.js` com Node 18+).
3. Anexe um disco/volume persistente e monte em `/data`; defina `DATA_DIR=/data` e `TRUST_PROXY=1`.
4. Publique e abra o endereço HTTPS que a hospedagem gerar. Confira o custo do disco persistente no plano escolhido.

Backup: copie a pasta `DATA_DIR` de vez em quando. Este armazenamento em arquivos serve bem para um site pequeno; com muitos usuários, o próximo passo é um banco de dados.
