# DuneFlow — Roadmap de Evolução: Física Granular, Atmosfera & Telemetria SCM

Documento consolidado com ideias de evolução para elevar a interação com a areia, o realismo atmosférico, a visualização científica SCM (*Soil Contact Model*) e as mecânicas emergentes off-road do **DuneFlow**.

> **Base atual já operacional na engine:** Cascatas toroidais em GPU (`ToroidalCascade` + `passSimStep`), terramecânica Bekker sem readback (`SandTerramechanics`), clipmap adaptativo (`ClipmapGeometry` + `terrainSand`), fumaça volumétrica instanciada (`VolumetricSmokeSystem`), partículas GPU (`particlesRoost`), iluminação híbrida quase-RT (`AtmosphericIBL`, `VehicleReflectionSystem`, `PostProcessingPipeline`), suspensão/dano 6-DOF e áudio Web Audio procedural.

---

## Fundamentos & Por que Estas Escolhas Importam

### Por que os exemplos iniciais formam o núcleo do roadmap
Os exemplos trazidos inicialmente acertam exatamente no ponto que separa simulações físicas de verdade de jogos genéricos — **conectar a matemática invisível da engine diretamente ao que o usuário vê e sente**:

1. **Widget “Physics Monitor” (slip angle, slip ratio, soil shear resistance):**
   - Como o `SandTerramechanics` já calcula afundamento de Bekker, `slipRatio` e arrasto por roda em tempo real (sem readback caro de GPU), expor esses valores no `ControlDock` dá **transparência científica imediata**: reduzir o PSI de 36 para 12 ou engatar 4L mostra na hora a resistência ao cisalhamento subir e o afundamento cair.
2. **Toggle “Tire Track” com splines dinâmicas não-persistentes:**
   - Rastros deformados na areia escondem a *história energética* da manobra (pico de tração vs. escavação excessiva). Um buffer não-persistente de splines leves sobre o rastro resolve dois problemas juntos: **custo de memória limitado** (a fita desaparece atrás do carro) e **leitura espacial clara** do comportamento do chassi e do *contact patch*.
3. **Partículas GPU de *sand dust* disparadas por `slipRatio` e moduladas pelo cisalhamento:**
   - Em vez de poeira genérica baseada só na velocidade, amarrar o emissor GPU ao limiar de `slipRatio` e à resistência ao cisalhamento ($\tau$) transforma a poeira em um **indicador físico honesto**: em rolagem pura quase não há poeira; quando o solo rompe por cisalhamento, o jato explode proporcionalmente ao esforço do pneu.
4. **Fumaça realista com biblioteca ou replicação de solver de fluido:**
   - Em vez de dezenas de *billboards* estáticos independentes, replicar um solver leve de fluido 2D (estilo *Stable Fluids* / *WebGL Fluid*) traz **conservação de momento e vorticidade** para a esteira do carro, fazendo a poeira girar em redemoinhos atrás da caçamba e responder ao vento lateral.

### Filosofia de Plataforma: **PC-First com Escalabilidade Inteligente**
O **DuneFlow tem o PC Desktop como plataforma principal** e **nunca deve ter seu teto de realismo capado pelas limitações de celulares**. Em vez de cortar recursos de alto impacto gráfico/físico por causa de GPUs móveis TBDR, a arquitetura opera com **física determinística idêntica em todas as plataformas** e **3 níveis reais de escalabilidade gráfica**:

| Perfil | Alvo Principal | Estratégia Arquitetural |
| :--- | :--- | :--- |
| **`Ultra` (PC Desktop)** | GPUs dedicadas PC / telas 60–144 Hz | **Sem compromisso:** núcleo rígido `JoltPhysics.js` (WASM 120 Hz), CSM 4 cascatas (`2048²`), cascatas toroidais `1024²`, *Bent Normals* no GTAO, atmosfera física (`@takram/three-atmosphere`) + sombras de nuvens, solver toroidal Navier-Stokes 2D real na esteira, sombras de poeira `256²` a 60 Hz, torção tangencial (*brush model*) no pneu, *Shallow Water 2D* dedicado, áudio *Waveguide* 4 linhas + PhISEM 4 canais e **modo experimental WebGPU/TSL (MLS-MPM granular local)**. |
| **`Híbrido` (PC Mid / Mobile High)** | Notebooks, GPUs integradas & celulares topo | Melhor relação realismo/ms: Jolt a 60–120 Hz, CSM 2 cascatas (`1024²`), pacote óptico completo (0 samplers extras no terreno), *sidewall bulge* + *tire caking*, poeira 6-way com *soft depth-fade* em meia resolução, sombra de poeira `128²` a 30 Hz, esteira aerodinâmica analítica (dipolo + von Kármán + Curl Noise), *Mip Fog* (*Uncharted 4*) e pós-processamento em *Uber-Composite*. |
| **`Leve` (Mobile Entry / Software GL)** | Celulares de entrada / bateria | Cascatas `512²` (8 MB VRAM), Jolt 60 Hz com corpo único (sem *ladder-frame flex*) e 3 pontos na banda, 1 shadow map direcional, *sidewall bulge* simplificado, escurecimento poroso + AO analítica, 6-way sem *depth-fade* (96 partículas), *Waveguide* 1 linha + PhISEM 2 canais — mantendo **a essência da física de solo e tração**. |

### Arquitetura de 5 Níveis Físicos & Fronteira de Autoridade
Para evoluir o DuneFlow para um **simulador híbrido de materiais granulares** sem duplicar areia nem provocar stalls de readback GPU, o motor opera em 5 camadas com responsabilidades e frequências claras:

| Nível | Sistema Autoritativo | Frequência / Domínio | Papel na Simulação |
| :--- | :--- | :--- | :--- |
| **Nível 1 — Mundo Rígido & Veículo** | `JoltPhysics.js` (WASM) | 120 Hz fixos (PC) / 60 Hz (Leve) | Chassi composto CCD 6-DOF, *Solid Axle*, *Ladder-Frame Flex*, rochas, peças soltas, *Maxtrax* e reboque |
| **Nível 2 — Solo Mecanicamente Autoritativo** | Bekker/SCM + `TerrainMaterialState` + `MixedContactResolver` | 120 Hz CPU (zero GPU readback) | Contatos multiponto (areia + rocha simultâneos sem duplicar força), compactação, *slip-sinkage*, *high-centering* e diferenciais |
| **Nível 3 — Terreno Conservativo de Grande Escala** | `ToroidalCascade` + `SedimentMassLedger` | GPU ping-pong + sync verificável | Espessura sobre substrato rígido, conservação de massa ($M_i = \rho_{b,i} A_i h_i$), avalanches conservativas e erosão eólica |
| **Nível 4 — Volume Granular Localizado *(Experimental PC)*** | WebGPU + TSL (`LocalMPM` / DEM) | Substeps CFL independentes (PC Ultra) | Areia 3D real perto de pneus/rochas/cavidades (inicialmente **sem** autoridade de força sobre o Jolt; acoplamento bidirecional é pesquisa separada) |
| **Nível 5 — Óptica, Iluminação & Áudio** | Three.js r187 + `AudioWorklet` | 60–144 FPS + 48 kHz áudio | CSM, atmosfera física, glints 4K estáveis, rebote quente, poeira 6-way, *Waveguide* + PhISEM e *Gamepad FFB* |

> **Regras de ouro WebGL2 / WebGPU / Three.js r187:**
> 1. **Zero GPU readbacks síncronos** no loop principal de física (120 Hz).
> 2. **Conservação de massa & sincronização:** areia escavada precisa aparecer em outro lugar ou virar partículas debitadas uma única vez (nunca criar duas cópias independentes da mesma areia); compactação não é perda de massa.
> 3. **Precisão `RGBA16F`:** manter a `ToroidalCascade` estritamente em **deltas relativos** (`±1,5 m`, ULP ≤ 1 mm), nunca sobre cota absoluta do terreno.
> 4. **Cota de samplers do terreno:** manter o fragment shader do clipmap abaixo de `16` `MAX_TEXTURE_IMAGE_UNITS` derivando porosidade, micro-shadowing, AO analítica e translucidez da `ToroidalCascade` e uniforms.
> 5. **Passo físico fixo (120 Hz via `THREE.Timer`):** obrigatório para estabilidade em monitores PC de 120–240 Hz; o substep CFL do MPM é desacoplado dos 8,33 ms do Jolt.

### Lógica da ordem das fases
As 7 fases (da **Fase 0** à **Fase 6**) seguem uma progressão onde **cada etapa gera ganho físico e visual mensurável**:
- **Fase 0 (Hardening & Performance):** corrige os 38 achados da auditoria (build/404, vazamentos GPU, bugs de física, draw calls, shader ALU, GC churn e *Uber-Composite*).
- **Fase 1 (Pneu Vivo, Contato Óptico & Visibilidade SCM):** borracha deformando com PSI/carga, pacote óptico de contato/porosidade/cristas/acúmulo em rochas (0 samplers extras), glints estáveis em 1440p/4K, poeira dirigida por `slipRatio` e *Physics Monitor*.
- **Fase 2 (Núcleo Físico Hardcore `JoltPhysics.js` & Colisões 6-DOF):** substitui solvers manuais e cilindros 2D por `JoltPhysics.js` (WASM 120 Hz), rodas *Shape-Cast* + contato misto areia/rocha, diferenciais bloqueáveis, *high-centering* real, risco de *debeading*/aro, eixo rígido, *ladder-frame flex* e dano plástico em Joules.
- **Fase 3 (Geomecânica Conservativa & Evolução da Paisagem):** fundação de massa conservativa (`TerrainMaterialState`, substrato rígido, `SedimentMassLedger`), *slip-sinkage*, *Chrono SCM*, *rut-wall trapping*, onda de proa, avalanches com ângulo estático vs. dinâmico, zonas heterogêneas e erosão eólica em rochas (*Inria 2024*).
- **Fase 4 (Iluminação PC Ultra, Atmosfera Física & Poeira Volumétrica):** CSM 4 cascatas sincronizadas ao clipmap, `@takram/three-atmosphere`, sombras de nuvens globais, rebote indireto quente da areia, poeira 6-way + sombra no solo (`Beer/Transmittance`) e esteira Dual-Tier (Navier-Stokes 2D no PC Ultra / analítica no Híbrido).
- **Fase 5 (Pacote Cinestésico, Áudio Waveguide + PhISEM & Periféricos PC):** câmera física 2ª ordem + *Horizon Roll-Blend*, *driveline twist*, *wheel-hop* PSI, síntese de motor/escape por *Waveguide* (`Engine_Sim`) + granular PhISEM em `AudioWorklet` e suporte PC a Gamepad/Volante com *Force Feedback*.
- **Fase 6 (Sandbox Off-Road, Laboratório WebGPU/MLS-MPM & Matriz de Validação):** pranchas *Maxtrax*, guincho XPBD + *deadman anchor*, reboque articulado, chuva/poças 2D, ferramentas científicas PC, rota experimental **WebGPU + TSL (MLS-MPM 2D→3D + DEM)** e **matriz quantitativa de 9 testes de validação**.

---

## Visão Geral das Fases

| Fase | Foco Principal | Resultado Esperado |
| :--- | :--- | :--- |
| **Fase 0 — Hardening, Física & Performance *(Auditoria)*** | 38 pontos da auditoria + passo fixo 120 Hz + *Uber-Composite* TBDR + `three-mesh-bvh` | Build de produção íntegro, base sem vazamentos e grande folga de GPU/CPU |
| **Fase 1 — Pneu Vivo, Óptica Granular & Visibilidade SCM** | *Soft-Tire WPO / Sidewall Bulge* + *Tire Caking* + Pacote Óptico + *Sand Drift* em rochas + glints 4K | Borracha viva, carro ancorado no solo, junção orgânica rocha–areia e telemetria SCM |
| **Fase 2 — Núcleo `JoltPhysics.js` (WASM) & Física Off-Road Hardcore** | CCD 6-DOF, *Shape-Cast* + contato misto, diferenciais/lockers, *high-centering*, *debeading*, eixo rígido e *chassis flex* | Colisões 3D impecáveis, *rock crawling* autêntico, atolamento real e dano em Joules |
| **Fase 3 — Geomecânica Conservativa & Evolução da Paisagem** | `TerrainMaterialState`, `SedimentMassLedger`, *slip-sinkage*, *Chrono SCM*, *rut-wall trapping*, avalanches conservativas e erosão eólica | Areia com memória histórica e conservação de massa que "briga" com o volante |
| **Fase 4 — Iluminação PC Ultra, Atmosfera & Poeira Volumétrica** | CSM 4 cascatas + `@takram/three-atmosphere` + sombras de nuvens + GI quente + poeira 6-way/sombra + fluido 2D PC | Visual de referência PC Ultra (1440p/4K) com degradação limpa no Híbrido/Mobile |
| **Fase 5 — Cinestesia de Peso, Áudio *Waveguide* + PhISEM & FFB PC** | Câmera 2ª ordem + *Horizon Roll-Blend* + *Waveguide* (`Engine_Sim`) + PhISEM (`AudioWorklet`) + Gamepad/Volante FFB | Sensação tátil e sonora completa de 2 toneladas + controle analógico fino |
| **Fase 6 — Sandbox Off-Road, Lab WebGPU/MLS-MPM & Validação** | *Maxtrax*, guincho XPBD, reboque 2 rodas, chuva 2D, Lab PC, protótipo **MLS-MPM 3D / DEM WebGPU** e 9 testes científicos | Sandbox off-road completo + fronteira experimental de areia 3D volumétrica calibrada |

---

## Fase 0 — Hardening, Correções de Física & Performance *(Auditoria Técnica)*

**Por que vem antes de tudo:** Empilhar fluido 2D, novas camadas de solo e widgets científicos sobre bugs de física ou shaders sobrecarregados multiplicaria retrabalho e derrubaria o FPS no celular. Esta fase reúne **todos os 38 achados verificados na auditoria completa dos 29 arquivos-fonte**, agrupados por área e prioridade (`[CRÍTICO]`, `[ALTO]`, `[MÉDIO]`, `[BAIXO]`).

### 0.1 Correções de Build, Rendering & Vazamentos de Memória ✅ *(12/12 concluídos)*
- [x] **`[CRÍTICO]` Texturas fotográficas da areia com 404 em produção (`WebSandAdapter.ts:577, 595`):** ✅
  - *Problema:* `texLoader.load('/src/assets/images/...')` usa paths literais de dev que o Vite não copia para `dist/` no `npm run build` (caindo no fallback borrado `128×128`), além de `sandstone_strata_albedo_1795181775786.jpg` (1,2 MB) estar sem uso.
  - *Ação:* Importado via ES Module (`import ... from '../../assets/images/...'`) e ativo órfão `sandstone_strata_albedo_1795181775786.jpg` removido.
- [x] **`[ALTO]` Vazamento na borda do guard band toroidal (`passSimStep.ts:128-140`):** ✅
  - *Problema:* `if (inGuard || outsidePrev)` promove rastros da `uParentCascade` dentro da faixa de guarda de 2 texels em vez de zerá-los, vazando sulcos para o lado oposto da janela de 32 m durante a avalanche.
  - *Ação:* Zerado `vec4(0.0)` quando `inGuard` e promoção da cascata pai restrita a `outsidePrev && !inGuard`.
- [x] **`[ALTO]` Emenda (seam) na textura procedural da lama (`MudTextureGenerator.ts:110`):** ✅
  - *Problema:* `valueNoisePeriodic(u * 0.5 + v * 0.14, v * 2.0, 12, 313)` usa períodos fracionários (`6` e `1,68`), criando cortes visíveis a cada wrap de UV.
  - *Ação:* Ajustado para períodos inteiros exatos `valueNoisePeriodic(u + v, v * 4.0, 6, 313)` com wrap contínuo em U e V.
- [x] **`[ALTO]` Sombra analítica e AO das rodas coladas no chão durante saltos e capotagens (`terrainSand.ts:624-655`):** ✅
  - *Problema:* `underBodyAO` e `wheelAO` checam apenas distância horizontal `XZ` (ignorando altura `Y` e rotação do chassi); no fallback sem shadow map, `ro.y` é clampado em `[-0.45, 0.45]`.
  - *Ação:* Atenuado contato/sombra por `uVehicleClearanceY`, desativado `wheelAO` quando capotado (`uVehicleUpright`) e atualizado ray-OBB 3D com base real do chassi.
- [x] **`[ALTO]` Divergência de `pixelRatio` e `resize` incompleto no mobile (`WebSandAdapter.ts:382-386, 771, 1991` vs `PostProcessingPipeline.ts:472-476`):** ✅
  - *Problema:* Em telas `< 768px`, o renderer usa DPR até `1.75` enquanto o composer/GTAO usa `1.5`; ao rotacionar o celular, `handleResize` nunca atualiza `renderer.setPixelRatio` nem `uPixelRatio` das partículas (`roostParticles` / `sparkParticles`).
  - *Ação:* Centralizado via `computeEffectivePixelRatio` em `SandParams.ts` e sincronizado no `handleResize` para renderer, pipeline e partículas.
- [x] **`[ALTO]` Vazamentos de recursos GPU no ciclo de vida (`DesertEnvironment.ts:61-63, 97`; `WebSandAdapter.ts:355-356, 576-607, 2095-2148`):** ✅
  - *Problema:* Mesh `Sky` morto é atualizado todo frame e nunca descartado; `pendingSimQuery`/`pendingFrameQuery` nunca recebem `gl.deleteQuery()`; callbacks assíncronos de `texLoader.load` podem vazar texturas se concluírem após `dispose()` (ex.: React StrictMode).
  - *Ação:* Removido `Sky` morto, adicionados `gl.deleteQuery()` no `dispose()` e proteção `if (this.disposed) { loaded.dispose(); return; }` + limpeza de texturas pendentes.
- [x] **`[MÉDIO]` Faíscas sem tone-mapping/gamma no modo direto (`particlesRoost.ts:497-529`):** ✅
  - *Ação:* Adicionado uniform `uLinearHdrOutput` com ACES + sRGB encode no `SPARK_PARTICLES_FRAG` e sincronizado em `setAllLinearHdrOutput`.
- [x] **`[MÉDIO]` Grama amassada/animada projeta sombra estática e levanta aos 16 m (`GrassFieldSystem.ts:330`):** ✅
  - *Ação:* Removido `castShadow` da grama, inicializados `uGrassCascade0`/`uGrassCascade1` com `DataTexture` 1×1 válida e integrado fallback da Cascade 1 no vertex shader.
- [x] **`[MÉDIO]` Degraus abruptos e bound subestimado nas lajes de pedra escaláveis (`DesertObstacles.ts:149, 200`):** ✅
  - *Ação:* Envelopado `facetNoise` para zerar suavemente antes de `r2 = 1.24` e atualizado bound AABB para `Math.hypot(halfX, halfZ) * 1.25`.
- [x] **`[MÉDIO]` Anel de horizonte (`ergDuneMesh`) intercepta dunas externas além de 70 m (`DesertEnvironment.ts:737` vs `TerrainHeightfield.ts:98-99`):** ✅
  - *Ação:* Reposicionado `rInner = 230 m` fora do clipmap (~248 m) e ancorada a elevação Y ao envelope `outerRise` do heightfield.
- [x] **`[MÉDIO]` Arranhões metálicos escurecem a pintura em vez de parecer aço (`VehicleCrashPhysics.ts:738-746`):** ✅
  - *Ação:* Criado atributo por vértice `aScrape` e mistura PBR de aço escovado claro (`metalness 0.90`, `roughness 0.30`, redução de clearcoat) no shader automotivo.
- [x] **`[BAIXO]` Facho dos faróis no terreno ignora pitch/roll do veículo (`terrainSand.ts:675-715`):** ✅
  - *Ação:* Passada a base 3D completa (`uVehicleFwd3D`, `uVehicleRight3D`, `uVehicleUp3D`) com pitch/roll reais para projetar faróis e lanternas em 3D no terreno.

### 0.2 Correções de Física, Dinâmica Veicular & Terramecânica ✅ *(10/10 concluídos)*
- [x] **`[CRÍTICO]` Arrasto de esterçamento com sinal invertido em marcha ré (`VehicleSuspensionPhysics.ts:439` / `VehicleRig.ts:930`):** ✅
  - *Ação:* Corrigido para `fFwdChassis = -fTireLat * sinS` (removido `dirSign` duplicado) e coberto com teste unitário (`node:test`).
- [x] **`[ALTO]` Sinal de `pitchVel` invertido no impacto de capotagem (`VehicleCrashPhysics.ts:348-351`):** ✅
  - *Ação:* Invertido o termo para `- state.pitchVel * leverZ * 0.45` com projeção exata `cosPitch`/`sinPitch` (`leverZ = lz * cosPitch + ry1 * sinPitch`) e sinal de rebote coerente.
- [x] **`[ALTO]` Rotação de referencial (Coriolis) incompleta faz momento linear girar "de graça" no ar (`VehicleRig.ts:954`):** ✅
  - *Ação:* Extraída e aplicada a rotação exata `rotateBodyVelocityByHeadingDelta(vForward, vLateral, dHeading)` preservando o momento linear mundial `(vx, vz)` no ar e em slides.
- [x] **`[ALTO]` Conflito entre solvers de suspensão vs. capotagem e `slerp` dependente de FPS (`VehicleRig.ts:1102-1125, 1542-1589`; `VehicleSuspensionPhysics.ts:175`):** ✅
  - *Ação:* Sincronizadas altura (`airY`/`chassisComWorldY`) e velocidades (`vy`, `rollVel`, `pitchVel`) nas transições `rolloverActive` e substituídos fatores fixos de `slerp` (`0.55`/`0.72`) por `1 - Math.exp(-k * dt)`.
- [x] **`[ALTO]` Peças soltas ejetadas em direção errada quando `heading != 0` (`VehicleRig.ts:499-507`):** ✅
  - *Ação:* Normal local de impacto rotacionada para o espaço de mundo via `localVectorXZToWorld(localNormalX, localNormalZ, heading)` antes de somar à velocidade mundial.
- [x] **`[MÉDIO]` Rodas no ar ainda reportam carga mínima (450 N) e afundamento mínimo (8 mm) (`VehicleRig.ts:812`; `SandTerramechanics.ts:314`):** ✅
  - *Ação:* Zerados `normalLoadN`, `sinkage`, `rollingResistanceN`, `bulldozingForceN` e `tractionFactor` quando `groundContact01[i] <= 0.01` ou `normalLoadN <= 0`.
- [x] **`[MÉDIO]` Colisões de rochas são cilindros 2D infinitos em Y + amortecimento dependente de FPS (`DesertObstacles.ts:289-358`; `VehicleRig.ts:967`):** ✅
  - *Ação:* Adicionada verificação vertical 3D contra `[rockYMin, rockYMax]` e amortecimento de raspagem independente de FPS via `Math.pow(0.88, dt * 60)`.
- [x] **`[MÉDIO]` Carga estática hardcoded (`staticLoad = 8460`) na suspensão (`VehicleSuspensionPhysics.ts:77, 104`):** ✅
  - *Ação:* Derivada dinamicamente via `computeStaticCornerLoadN(sprungMassKg, unsprungMassKg)` = `(sprungMassKg / 4 + unsprungMassKg) * 9.81`.
- [x] **`[MÉDIO]` Personagens (Runners) atravessam pedras escaláveis (`RunnerRig.ts:226, 289`):** ✅
  - *Ação:* Substituído `sampleBaseTerrain` por `sampleSurfaceAt` incluindo `CLIMBABLE_ROCK_SLABS` e respeitando o bioma ativo.
- [x] **`[BAIXO]` `RunnerRig` consulta o ring buffer mesmo para o pé no ar (`RunnerRig.ts:292`):** ✅
  - *Ação:* Consulta a `terramechanics.evaluateFootContact` restrita apenas à fase de apoio (*stance*) em solo deformável.

### 0.3 Otimização Estrutural de Desempenho (GPU, CPU/GC, Mobile & React) ✅ *(11/11 concluídos)*
- [x] **`[CRÍTICO]` Redução de ~200+ para ~20 draw calls no caminhão (`VehicleMeshBuilder.ts`):** ✅
  - *Ação:* Aplicado `mergeGeometries` por grupo/material em `bodyGroup`, molas e subconjuntos destacáveis e geometria compartilhada mesclada entre as 5 rodas Raptor beadlock.
- [x] **`[CRÍTICO]` Remover 25 trigs/pixel do terreno no fragment shader da fumaça (`particlesRoost.ts:258`):** ✅
  - *Ação:* Passado `vGroundY` do vertex shader (`VOLUMETRIC_SMOKE_VERT`) como varying e removido `getBaseTerrainHeight` / `COMMON_TOROIDAL_GLSL` do fragment shader da fumaça.
- [x] **`[CRÍTICO]` Eliminar shadow pass e culling desligado dos 133.200 triângulos de grama (`GrassFieldSystem.ts:321-332`):** ✅
  - *Ação:* `castShadow = false`, densidade adaptativa no mobile, skip de cascata toroidal em tufos distantes e `frustumCulled = true` com `boundingSphere` ancorado no veículo.
- [x] **`[ALTO]` Podar texture fetches e trigs desperdiçados no shader do terreno (`terrainSand.ts`):** ✅
  - *Ação:* Exportado `vBaseHeight` do vertex clipmap, branch antecipado para `Rainy Highway` antes dos taps toroidais, early-outs por distância/peso (`midGrainFade`, `atten`, `depression + bermMass < 0.004`) e blocos trigonométricos guardados por máscara.
- [x] **`[ALTO]` Perfil adaptativo de VRAM/GTAO para mobile (`WebSandAdapter.ts`; `PostProcessingPipeline.ts`):** ✅
  - *Ação:* Cascatas adaptativas (`512²` = 8 MB no mobile/SW-GL vs `1024²` = 32 MB no desktop), GTAO em meia resolução no mobile e Bloom em meia resolução.
- [x] **`[ALTO]` Eliminação de GC churn nos hot-loops de física e render (`WebSandAdapter.ts`; `VehicleSuspensionPhysics.ts`; `VehicleCrashPhysics.ts`; `VehicleRig.ts`; `VehicleReflectionSystem.ts`):** ✅
  - *Ação:* Pré-alocados scratch buffers tipados (`Float64Array`, `_rolloverProbes`, `mirrorMaterials`), callbacks bound zero-GC, reaproveitamento de alturas do terreno no `syncVisualTransform` e amortização de `computeVertexNormals()`.
- [x] **`[MÉDIO]` Evitar chamada de `updateHeadlightsForWeather` todo frame (`WebSandAdapter.ts` / `VehicleRig.ts`):** ✅
  - *Ação:* Adicionada dirty-flag por `(weatherPreset, biome, brokenMask, overrideMask)` disparando atualizações de materiais/luzes apenas em mudanças reais.
- [x] **`[MÉDIO]` Rejeição rápida por AABB no ring buffer da terramecânica (`SandTerramechanics.ts`):** ✅
  - *Ação:* Guardados bounds `minX/maxX/minZ/maxZ` pré-expandidos por segmento + retorno rápido sem scan quando roda está no ar (`normalLoadN <= 0`).
- [x] **`[MÉDIO]` Suspender `AudioContext` ao silenciar + reutilizar buffer de impacto (`VehicleAudioEngine.ts`):** ✅
  - *Ação:* `ctx.suspend()`/`ctx.resume()` no mute/unmute, `crashNoiseBuf` pré-gerado uma única vez, throttle de `setTargetAtTime` a 25 Hz e `.disconnect()` no `onended`.
- [x] **`[BAIXO]` Isolar re-renders de telemetria no React (`App.tsx`; `ControlDock.tsx`; `MobileDrivePad.tsx`):** ✅
  - *Ação:* `React.memo` em `ControlDock` e `MobileDrivePad` com callbacks estabilizados via `useCallback`.
- [x] **`[ALTO — PC 120/144 Hz & WebGL2 Hygiene]` Passo físico fixo via `THREE.Timer`, *Uber-Composite* TBDR & Recursos Three.js r187:** ✅
  - *Ação:* Migrado loop para `THREE.Timer` (r187) com clamp `dt <= 33 ms` e reset ao retornar da aba, pré-multiplicação AgX + clip-space SSCS no `PostProcessingPipeline` e `gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.STENCIL_ATTACHMENT])` ao fim do frame.

### 0.4 Sincronização de Estado, Acessibilidade/UX & Telemetria Honesta ✅ *(3/3 concluídos)*
- [x] **`[ALTO]` Dessincronização de clima e exposição ao trocar bioma (`ControlDock.tsx` vs `WebSandAdapter.ts`):** ✅
  - *Ação:* Adicionado `onConfigSync` da engine para o React (cobrindo trocas de bioma, `goToRockTrail()`, atalhos `KeyV` e touchscreen SYNC 4) e incluídos `weatherPreset`/`exposure` diretamente nos botões de bioma.
- [x] **`[MÉDIO]` Acessibilidade dos botões `4H/4L`/`PSI` e proteção touch em tablets (`MobileDrivePad.tsx`; `ControlDock.tsx`):** ✅
  - *Ação:* Suportada ativação via teclado (`Enter`/`Space` via `onClick` com guarda anti-duplo-disparo) no `MobileDrivePad` e adicionado guard não-passivo de `touchstart`/`touchmove` na barra hold-to-drive em tablets.
- [x] **`[BAIXO]` Corrigir métricas hardcoded/imprecisas na aba Orçamento (`ControlDock.tsx`; `WebSandAdapter.ts`):** ✅
  - *Ação:* Exibida capacidade real do ring buffer (`/512 seg`), resolução/VRAM real das cascatas (`2× 512²` = 8 MB vs `2× 1024²` = 32 MB) e indicação honesta `N/D` quando `EXT_disjoint_timer_query_webgl2` não está disponível (removido `+ 0.78 ms` sintético).

---

## Fase 1 — Pneu Vivo, Contato Óptico & Visibilidade SCM *(Maior Salto Perceptivo / Custo)*

**Por que vem primeiro:** Fecha de uma vez as duas lacunas visuais mais fortes da simulação atual: hoje mudar de `36 PSI` para `10 PSI` altera a física mas o pneu continua um cilindro rígido, e o encontro borracha–solo depende só de shadow map/GTAO. Tudo aqui roda com **zero samplers extras no terreno**, mantendo orçamento mínimo no mobile e máxima nitidez no PC.

### 1.1 Deformação Analítica da Carcaça do Pneu (*Soft-Tire WPO + Sidewall Bulge*) & *Tire Caking*
- **Por que é prioridade nº 1:** Vende instantaneamente que o pneu tem borracha, ar e 2 toneladas em cima — visível na câmera principal, na GoPro Roda, no `CubeCamera` e nos retrovisores sem draw calls extras.
- **Formulação & Integração:**
  - Rigidez vertical pneumática (Wong): $k_z(\text{PSI}) = k_{\text{carcass}} + c_p \cdot \text{PSI}$ (ex.: $k_{\text{carcass}} \approx 45\,\text{kN/m}$, $c_p \approx 6{,}5\,\text{kN/(m}\cdot\text{PSI)}$ para pneu 33"), gerando deflexão $\delta = \text{clamp}(F_z / k_z,\, 0,\, 0{,}65H)$ (~1,9 cm a 36 PSI vs. ~4,7–10,5 cm a 10 PSI).
  - **Preservação do aro rígido (`m_rim`):** máscara radial `smoothstep` mantendo a roda metálica perfeitamente circular.
  - **Achatamento $C^1$ da banda + Bojo lateral ($\Delta w \approx 0{,}55\delta$):** vértices abaixo de $y_c = -R_0 + \delta$ achatam suavemente via *smooth-max* alinhado à normal local do solo, enquanto o flanco estufa no eixo $x_{\text{hub}}$ com recálculo analítico de normal.
  - **Armadilhas evitadas:** manter `mesh.rotation.x = 0` e aplicar `uSpinAngle` **dentro do vertex shader antes do achatamento** no espaço local da manga de eixo em `highp float` (impede achatamento girando com a roda e quantização longe da origem); sincronizar o mesmo WPO no `customDepthMaterial` para não descolar a sombra.
  - **Tire Caking acoplado:** máscara de cavidade nos cravos controlada por `uCakeLevel[4]` (enche na lama/areia úmida e limpa pela aceleração centrífuga $\omega^2 R_0$ arremessando torrões).
- **Escalabilidade:** `Leve` (achatamento + bojo sem recálculo de normal) · `Híbrido` (completo + `customDepthMaterial` + *tire caking*) · **`Ultra PC`** (+ **torção tangencial da banda** por modelo *brush* proporcional ao torque e `slipAngle` $\beta$, espetacular na câmera GoPro).

### 1.2 Pacote Óptico de Contato, Areia AAA & Acúmulo em Rochas *(Zero Samplers Extras no Terreno)*
- **O que faz na prática:** Transforma a leitura de peso, micro-superfície e profundidade dos sulcos sob qualquer ângulo solar (inclusive em 1440p/4K no PC) usando apenas os canais já amostrados da `ToroidalCascade` + uniforms leves:
  1. **Estratificação Subsuperficial & Escurecimento Poroso em 4 Fases (Lagarde + *Uncharted 4*):** expõe areia subsuperficial mais escura e saturada no fundo do rastro (`depression` + `compaction`), transitando entre **(D) seco** → **(C) poroso escuro e fosco** (sem brilho plástico artificial) → **(B) filme de tensão superficial** suavizando rugosidade → **(A) poça plana** com normal forçada para `(0, 1, 0)`. Liga compactação e umidade às propriedades ópticas e mecânicas simultaneamente.
  2. **Oclusão Analítica de Contato Pneu–Chassi (*Grounding AO*, Iñigo Quílez):** 4 elipsoides (rodas) + 1 cápsula (chassi) avaliados apenas no raio de 6 m (early branch no resto da tela), compostos multiplicativamente $V_{\text{total}} = \prod (1 - A_k)$ apenas na luz indireta (IBL) e combinados com `min(aoGTAO, aoAnalytic)` para nunca gerar dupla oclusão.
  3. **Micro-Shadowing Direcional de Sulcos (*Call of Duty: WWII*, Chan 2018) + Oclusão Especular (*Google Filament*):** usa o Laplaciano negativo dos 4 taps já lidos da `ToroidalCascade` para escurecer frestas no terminador solar e eliminar vazamento especular dentro de cavidades.
  4. **Translucidez Rasante em Cristas (Barré-Brisebois / *Journey*) + *Bent Normals* no PC Ultra:** a convexidade positiva do mesmo Laplaciano cria brilho âmbar translúcido em cristas e lábios de *berms* contra o sol; no **`Ultra PC`**, ativa saída de ***Bent Normals* no `GTAOPass`** (Jimenez 2016) inclinando a amostragem do `AtmosphericIBL` para fora das paredes do sulco.
  5. **Acúmulo de Areia na Base das Rochas (*Wind-Blown Sand Drift*):** no shader das rochas, usar *Height-Lerping* combinando altura relativa ao terreno + ângulo de repouso ($\theta < 33^\circ$) + ruído direcional de vento para fundir organicamente a base da pedra com o material exato da areia, eliminando a linha dura de interseção poligonal.
  6. **Glints *Deliot–Belcour* Estáveis em 1440p/4K + Microcristas Barlavento/Sotavento:** adicionar *mipmap bias* dinâmico baseado em `fwidth(vUv)` e filtro espaço-temporal nos glints (sem ruído pixelado à distância), campo espacial de tamanho aparente de grão modulando *roughness*/densidade de glints, bordas irregulares de sulcos e distinção visual entre face barlavento (suave) e sotavento (*slip-face*).

### 1.3 Widget “Physics Monitor (SCM)”, Poeira Dirigida por Slip/Cisalhamento & Overlay Diagnóstico
- **Physics Monitor (SCM) em Canvas 2D:** Mini-diagrama 4×4 colapsável (`FL`, `FR`, `RL`, `RR`) exibindo `slipAngle`, `slipRatio`, resistência ao cisalhamento $\tau$, afundamento $z$, arrasto de compactação $R_c$ vs. *bulldozing* $R_b$ e *sparkline* motriz × resistência — oculto por padrão e desenhado em Canvas 2D a 15–20 Hz (zero DOM thrashing).
- **Partículas GPU de Poeira Moduladas por Dissipação Física:** Taxa de emissão e opacidade vinculadas à dissipação real (`max(0, slipRatio - 0.12)` × cisalhamento de Janosi-Hanamoto e 2,5× em *Fesh-Fesh*), separando claramente poeira fina de grãos balísticos grandes.
- **Overlay “Tire Track” (Modo Diagnóstico Opcional):** Mantido como toggle opcional de engenharia/telemetria (desligado por padrão para preservar imersão diegética), desenhando fitas 3D leves com largura do *contact patch* e cor por eficiência de cisalhamento.

---

## Fase 2 — Núcleo Físico Hardcore (`JoltPhysics.js` WASM) & Colisões Avançadas 6-DOF

**Por que esta fase é estrutural:** Elimina definitivamente os cilindros 2D das rochas, o raycast pontual das rodas e a dupla autoridade entre suspensão e capotagem. `JoltPhysics.js` (MIT, WASM a 120 Hz fixos) assume corpo rígido CCD 6-DOF, juntas e colisões 3D complexas enquanto a terramecânica Bekker/SCM continua sendo a fonte autoritativa das forças de solo **sem GPU readback**.

### 2.1 Migração para `JoltPhysics.js` (WASM 120 Hz) + *Shape-Cast* & `MixedContactResolver`
- **Arquitetura:** Novo núcleo `PhysicsWorldJolt.ts` rodando a 120 Hz fixos no PC (`~8,33 ms` por substep; 60 Hz no perfil Leve), com `three-mesh-bvh` complementar para consultas geométricas/hulls.
- **Rodas *Shape-Cast* + Arco Multiponto (Contato Misto Sem Duplicação):**
  - Executa `CastShape` com `CylinderShape` contra malhas estáticas/dinâmicas de rochas (`MeshShape`/`ConvexHullShape`) e obstáculos, obtendo o ponto exato na quina e a normal 3D.
  - Em paralelo, amostra 5–7 pontos em arco na banda de rodagem (`-35°` a `+35°` + regiões laterais) contra o `TerrainContactProxy` CPU.
  - **Correção crítica (`MixedContactResolver`):** Em vez de escolher rigidamente "só rocha ou só areia", resolve **patches ativos simultâneos** (pneu apoiado metade na pedra, metade na areia) distribuindo a carga normal total $F_z$ sem duplicar forças.
- **Higiene WASM:** Pool pré-alocado de `Jolt.Vec3` / `Jolt.Quat` no boot e `Jolt.destroy()` explícito apenas na remoção de objetos (zero GC e zero vazamento de heap WASM).

### 2.2 Trem de Força 4×4 Real (`DrivetrainSolver` inspirado em `ChShaftsDrivetrain`)
- **Diferenciais Selecionáveis:**
  - **Aberto:** divide torque 50/50 com $\omega_{\text{eixo}} = (\omega_E + \omega_D)/2$ — se uma roda fica no ar numa pedra, ela gira livre e o carro trava;
  - **LSD (Torsen/Viscoso):** torque resistente proporcional a $\Delta\omega$: $\tau_{\text{lock}} = \text{clamp}(k_{\text{visc}}(\omega_E - \omega_D), -\tau_{\max}, \tau_{\max})$;
  - **Bloqueios Dianteiro e Traseiro (Lockers):** impõem $\omega_E = \omega_D$ com clamping viscoso próximo a $\Delta\omega \approx 0$ (evitando oscilação numérica) e geram ***driveline wind-up*** realista (aumento do raio de giro e resistência ao esterçar em piso firme).
- Inclui conversor de torque / embreagem e integração direta via `Wheel.SetTorque()`.

### 2.3 *High-Centering* & Arrasto Real de Barriga / Diferenciais (*Undercarriage Drag*)
- **O que muda:** Amostra superfícies/regiões inferiores do veículo (diferencial dianteiro, cárter, caixa de transferência, longarinas e diferencial traseiro) contra o `TerrainContactProxy` e `CastRay` curto para rochas.
- **Mecânica assinatura de *MudRunner/SnowRunner*:** Quando os sulcos ficam mais fundos que o vão livre, a barriga recebe sustentação vertical no Jolt que **rouba carga normal ($F_z$) das 4 rodas**, reduz tração, aplica resistência passiva de *bulldozing* e registra pincel no `BrushEncoder` para o diferencial "arar" a crista central.

### 2.4 Risco Real de PSI Extremo (*Rim-Strike*, Rigidez Lateral & *Debeading*)
- **Trade-off autêntico (10 a 36 PSI):** Baixar para 10–12 PSI amplia a área de contato (~180%) e reduz o afundamento, mas diminui a rigidez lateral $C_\alpha$ (direção mais mole, maior *slip angle*), reduz a folga até o aro (**batida seca de aro / *rim-strike*** com impulso rígido, faíscas e som metálico em quinas de pedra) e acumula risco de **destalonamento (*debeading*)** se `PSI < 14` sob alta força lateral (cai para 0 PSI e perde 90% da rigidez lateral até reparar).

### 2.5 *Solid Axle* (Eixo Rígido) & Torção de Longarina (*Ladder-Frame Chassis Flex*)
- **Eixo Rígido:** Conecta fisicamente as duas rodas de um eixo a um corpo/braço articulado (`HingeConstraint` / *trailing arms*), induzindo câmber oposto realista e mantendo o vão livre do diferencial coerente em cruzamento de eixos.
- **Torção de Chassi:** Divide o caminhão em 2 corpos rígidos no Jolt (Dianteiro/Cabine + Traseiro/Caçamba) unidos por `SixDOFConstraint` permitindo apenas torção longitudinal controlada ($\pm 8^\circ$ em roll, mola + amortecedor) — fundido em corpo único no perfil `Leve` mobile. (Conceito inspirado em *Rigs of Rods*, implementado do zero sobre Jolt sem código GPL.)

### 2.6 Dano Plástico por Energia (Joules), Pedras Enterradas Dinâmicas & Chassi Composto
- **Chassi `CompoundShape` + Deformação em Joules:** Na callback `OnContactAdded` do Jolt, calcula $E = \frac{1}{2} m_{\text{efetivo}} v_{\text{rel}}^2$, diferenciando impactos rígidos de resistência granular prolongada e deformando permanentemente o *Vertex Buffer* da lataria no ponto/vetor do impulso.
- **Pedras Parcialmente Enterradas:** Pedras inicialmente sustentadas pela areia perdem apoio conforme a erosão/escavação remove o sedimento ao redor e passam a rolar dinamicamente no Jolt.

---

## Fase 3 — Geomecânica Conservativa, Massa & Evolução da Paisagem

**Por que está nesta fase:** Eleva a areia de "heightmap que afunda" para um **meio granular com conservação de massa, memória histórica e resposta mecânica real**, mantendo execução CPU/GPU determinística e verificável.

### 3.1 `TerrainMaterialState`, Substrato Rígido & `SedimentMassLedger` *(Fundação P0)*
- **Estado independente do shader:** Cada célula/região guarda espessura de areia solta sobre **substrato rígido** (terra compactada ou rocha — impede escavar infinitamente), densidade aparente $\rho_b$, compactação, umidade, resistência ao cisalhamento e histórico de passagens.
- **Conservação explícita de massa ($M_i = \rho_{b,i} A_i h_i$):**
  - Atualiza $M_i^{t+1} = M_i^t + \sum M_{\text{entrada}} - \sum M_{\text{saída}} + M_{\text{fonte}}$, separando **compactação** (altura cai porque $\rho_b$ subiu, sem perda de massa) de **remoção/transporte**.
  - **Transações de deformação + Contrato de Sincronização CPU/GPU (`TerrainStateSync`):** toda deformação gera operação única atualizando `TerrainContactProxy` (CPU) e `BrushEncoder` (GPU), garantindo que avalanches e relaxamentos não deixem colisão dessincronizada da malha visual; coordenadas mundiais estáveis independentes do wrap toroidal.

### 3.2 *Slip-Sinkage*, Histerese Elasto-Plástica (*Chrono SCM*), Dilatância & *Rut-Wall Trapping*
- ***Slip-Sinkage* (Lyasko 2010 / Ding et al.):** Patinar forte (`slipRatio > 0.4`) escava 2–3× mais fundo ($z_{\text{total}} = z_0(1 + k_s |s|^{1{,}3})$), punindo excesso de acelerador em 36 PSI e recompensando 12 PSI + `4L` (~18% menos afundamento e ~34% menos arrasto de compactação). Regularização em baixa velocidade: $s = (\omega r - v) / \max(|\omega r|, |v|, 0{,}3)$.
- **Descarregamento Elástico (*Project Chrono SCM*):** $\sigma_{\text{try}} = k_e(z - z_p)$ sobre profundidade plástica $z_p$, eliminando tremores ao parar/balançar no sulco.
- **Resposta Longitudinal & Lateral Separadas + *Rut-Wall Trapping*:** curvas distintas para `slipRatio`, `slipAngle` e cisalhamento; resistência ao rolamento dependente da cunha frontal; paredes de sulcos profundos puxam lateralmente o pneu e exigem ângulo/torque para escapar; ombro do pneu empurra montes contra as paredes.
- **Compactação Progressiva & Dilatância:** primeira passagem deforma muito mais que passagens repetidas no mesmo trilho; suporte a contração (areia solta) vs. expansão (areia densa) sob cisalhamento.

### 3.3 Onda de Proa Assimétrica (*Bow-Wave*), Avalanches Conservativas & Perfil V vs. U
- **Onda de Proa & Montes de Atolamento:** 4 pincéis assimétricos deslocados por `slipAngle` $\beta$ empilham areia à frente da roda — em atolamentos, o monte formado oferece resistência mecânica real contra tentativas posteriores de avanço.
- **Avalanche com Fluxo Conservativo + Histerese:** transfere massa calculada entre células (em vez de suavizar cegamente) com **ângulo de repouso estático vs. dinâmico** distintos e variáveis por tipo de solo (evitando oscilações artificiais).
- **Biomas & Cravos Procedurais:** perfil **V** na areia seca vs. **U** na lama coesiva + *mud offset* (*Spintires/MudRunner*); canal `microImprint` gera normal + micro-AO procedural alinhada ao rolamento sem aliasing (borrando quando `slipRatio > 0.35`).

### 3.4 Zonas Heterogêneas Determinísticas (CPU = GPU), Erosão Eólica em Obstáculos & *Singing Sand*
- **Zonas (grade `64×64` ou hash inteiro idêntico em CPU e GPU):** Areia de Duna padrão, **Fesh-Fesh** (baixo $k_\phi$, alto $k_s$, poeira 2,5×), **Crosta Salina Quebradiça** (rompe em $p > p_{\text{yield}}$ com estalo) e **Areia Úmida de Baixada**.
- **Transporte Eólico & Deposição em Rochas (*Windblown Sand Around Obstacles* — Inria 2024 / *Oasis*):** separa *saltation*, suspensão e deslocamento superficial; modela sombra aerodinâmica das rochas para erodir barlavento e depositar sedimento a sotavento com recuperação superficial lenta (sem apagar compactação profunda).
- **Avalanches em Encostas & *Singing Sand*:** detecção CPU em encostas $> 30^\circ$ sob cisalhamento acionando fluxo conservativo, partículas descendo o gradiente e ressonador 70–105 Hz (+ harmônico 2×).

---

## Fase 4 — Iluminação PC Ultra, Atmosfera Física & Poeira Volumétrica *(Dual-Tier)*

**Por que está nesta fase:** Leva iluminação, céu e fumaça ao padrão *Forza Horizon 5 / Uncharted 4* no PC Ultra enquanto mantém degradação limpa para Híbrido e Mobile.

### 4.1 Cascaded Shadow Maps (`three/addons/csm/CSM.js`) Integrados ao Clipmap
- **PC Ultra:** 4 cascatas (`2048²` com *texel snapping* anti-swimming): `0–8 m` (cravos/molas/para-choque ultra-nítidos), `8–30 m` (pedras próximas), `30–120 m` (morros/rochas), `120–600 m+` (dunas distantes).
- **Sincronia obrigatória:** injetar exatamente o mesmo vertex displacement toroidal no `customDepthMaterial` do CSM com bias dinâmico por cascata para eliminar descolamento de sombra em dunas íngremes.
- **Escalabilidade:** `Híbrido` (2 cascatas `1024²`) · `Leve` (1 shadow map direcional).

### 4.2 Atmosfera Física (`@takram/three-atmosphere`), Sombras de Nuvens & Rebote Quente da Areia
- **Atmosfera Física:** **`Ultra PC`** usa `@takram/three-atmosphere` (Bruneton/Hillaire com LUTs de transmitância/espalhamento e calibração HDR estrita antes do Bloom/AgX para evitar estouro `RGBA16F`); **`Híbrido` / `Leve`** usa ***Mip Fog* (*Uncharted 4*)** amostrando o PMREM do `AtmosphericIBL` + fase Mie (1 fetch).
- **Sombras de Nuvens Globais (<0,2 ms):** textura 2D FBM em evolução lenta projetada no plano mundial `XZ` modulando irradiância solar direta no terreno, rochas e veículo — cria grandes nuvens cruzando o deserto sem pagar 8–12 ms de raymarching 3D.
- **Rebote Indireto Quente (GI Leve):** termo hemisférico `dot(N, vec3(0, -1, 0))` modulado pela cor do bioma + *Bent Normals* do GTAO iluminando a barriga do caminhão e caixas de roda, somado a *multi-bounce* quente nas *slip-faces* das dunas (preservando oclusão para não somar luz fictícia sem visibilidade do solo).

### 4.3 Poeira 6-Way Lightmap, *Soft Depth-Fade*, Sombra no Solo & Esteira Dual-Tier
- **6-Way Lightmap (RTB + LBF) + *Soft Depth-Fade* Sem Feedback Loop:** opacos em `rtOpaque` + poeira em `rtDust` (resolução nativa no **Ultra PC**, meia resolução no **Híbrido**) lendo `rtOpaque.depthTexture` manualmente, com polígonos octogonais recortados.
- **Sombra Projetada da Poeira (*Beer/Transmittance*):** splatting aditivo `R8`/`RGBA8` (sem depender de `EXT_float_blend`), `256²` a 60 Hz no **Ultra PC** (`384+` partículas) e `128²` a 30 Hz no **Híbrido** (`~192` partículas), aplicada no `PostProcessingPipeline` (0 samplers extras no terreno).
- **Esteira Aerodinâmica Dual-Tier:** **`Ultra PC`** roda solver toroidal Navier-Stokes 2D real em GPU (`128²–256²`); **`Híbrido` / `Leve`** usa campo analítico (dipolo + vórtices de von Kármán + 2D Curl Noise, zero FBOs extras).
- **Faróis Volumétricos & *Wake Dust Clinging*:** 2 cones geométricos *Fresnel-faded* + *depth-fade* e máscara analítica de acúmulo de poeira na traseira/arcos de roda (lavável na água).

---

## Fase 5 — Cinestesia de Peso, Áudio *Waveguide* + PhISEM & Periféricos PC

**Por que está nesta fase:** Conecta a física hardcore de 120 Hz diretamente aos sentidos do piloto no PC (câmera, som físico sem samples e controles analógicos com *Force Feedback*).

### 5.1 Câmera Física 2ª Ordem + *Horizon Roll-Blend* + *Driveline Twist* & *Wheel-Hop*
- **Câmera Inercial (*BeamNG v0.38*):** equação massa-mola $\ddot{d}_c = \omega_n^2(d_{\text{alvo}} - d_c) - 2\zeta\omega_n\dot{d}_c$ em passo fixo, horizonte 70–80% estabilizado em costelas (caindo para 0% acima de 55° em capotagens), micro-impulso nos *bump-stops* e *FOV pump* contido ($\le 5^\circ$).
- **Dinâmica Secundária:** torque reativo do cardã em `4L` ($\tau_{\text{roll}} = c_{\text{drive}} \cdot \tau_{\text{cardã}}$), *wheel-hop* pneumático (12,5 Hz @ 36 PSI vs. 7,9 Hz @ 10 PSI) ligado ao `Sidewall Bulge` e pêndulos leves amortecidos (antena, para-barros, carga).

### 5.2 Áudio Mecânico por *Waveguide* (`Engine_Sim`) + Granular PhISEM em `AudioWorklet`
- **Motor & Transmissão por *Waveguide* (`engine-synth.worklet.ts`, inspirado em `YigitSalihEmecen/Engine_Sim`):** zero arquivos `.wav`/osciladores genéricos; roda em thread dedicada de áudio recebendo telemetria a 120 Hz via `SharedArrayBuffer` ou `MessagePort` leve:
  - Pulsos discretos de combustão por cilindro conforme o ângulo do virabrequim ($\theta$);
  - 2 a 4 linhas de atraso (*delay lines* passa-baixa — 1 linha no `Leve`) simulando coletor e escapamento;
  - *Turbo spool + blow-off*, chiado de engrenagem reta na reduzida `4L` e ***gear-lash clunk*** nos diferenciais bloqueados.
- **Granular PhISEM (Perry Cook) acoplado:** 4 canais com panorâmica 3D por roda no **PC / Híbrido** (2 por eixo no **Leve**) sintetizando cisalhamento de areia seca (2,1 / 4,2 kHz), *Singing Sand* (85–95 Hz), sucção de lama (350 Hz → 1,4 kHz), estalo de crosta salina e raspar metálico de *high-centering*.
- **Build Vite seguro:** carregar worklets via `?worker&url` / `new URL(..., import.meta.url)` com fallback automático em `BiquadFilterNode`.

### 5.3 Periféricos de Simulador PC: Gamepad Analógico & Volante (*Force Feedback* / Rumble)
- **Gamepad API (`GamepadHaptics.ts`):** curvas de sensibilidade para acelerador/freio/direção analógicos (fundamental para dosar tração e evitar *slip-sinkage*!) + *rumble* dual-channel dirigido pelas forças de contato do Jolt:
  - **Canal grave (baixa frequência):** *wheel-hop*, *rim-strike* em 10 PSI, engasgo em baixa rotação e batidas de suspensão;
  - **Canal agudo (alta frequência):** textura de *slip-sinkage*, resistência de *rut-wall trapping* e quebra de crosta.

---

## Fase 6 — Sandbox Off-Road, Laboratório WebGPU/MLS-MPM & Validação Científica *(PC Showcase)*

### 6.1 Interações Sandbox no Jolt + `BrushEncoder`
- **Peças Destacadas, Pedras Soltas & Anel de Choque:** corpos rígidos do Jolt que quicam nas rochas e consultam o terreno CPU, emitindo crateras/sulcos nos slots livres do `BrushEncoder` + anel radial no pico de aterrissagem $F_z$.
- **Pranchas *Maxtrax*:** 2 corpos/OBBs leves (`three-mesh-bvh` + Jolt) sobrescrevendo localmente $k_\phi$ e $c$ em `SandTerramechanics`, arremessadas para trás se o pneu patinar bruscamente.
- **Guincho Elástico XPBD + Âncora de Areia (*Deadman Anchor*) & Reboque Articulado:** cabo visual 1D em XPBD aplicando força elástica real (Hooke + amortecimento) no Jolt e rasgando vala se arrancar a âncora; reboque de 2 rodas conectado por `PointConstraint`/`ConeConstraint` deixando 2 sulcos extras no `BrushEncoder`.
- **Chuva Localizada & Poças 2D *(Dual-Tier)*:** acúmulo em `depression` com 4 fases ópticas; grade dedicada `128²`/`256² RG16F` de perturbação relativa (*Shallow Water 2D*) no **Ultra PC** e anéis analíticos no **Híbrido/Leve**.

### 6.2 Modo Laboratório Científico & Ferramentas de Debug *(Opcional — PC)*
- **Debug Físico Completo:** visualização opcional de contatos mistos, normais, pressões, densidade, compactação, fluxos de sedimento e campos SDF.
- **Fantasma Comparativo (`36 PSI` vs `12 PSI`), Replays Determinísticos (seed + eventos de deformação), Lupa Diagnóstica GPU e Scanner Geotécnico Subterrâneo.**

### 6.3 Rota Experimental PC Ultra — WebGPU + TSL & Volume Granular Localizado (MLS-MPM / DEM)
- **Política arquitetural:** O motor principal permanece 100% sólido em **WebGL2**. O modo experimental **"PC Ultra (WebGPU)"** utiliza `WebGPURenderer` + **TSL** (Three.js r187) para rodar um volume local móvel (`4m × 4m × 0,4m`) ao redor das rodas/obstáculos sem migrar toda a engine prematuramente.
- **Implementação rigorosa (sem chutes de FPS):**
  - Validar primeiro um **protótipo MLS-MPM 2D isolado** (queda, empilhamento, cisalhamento, colapso) antes de evoluir para 3D;
  - Modelo constitutivo **Drucker–Prager** (e estudo futuro de modelos hipoplásticos/estado crítico para dilatância), **grade 3D ativa e esparsa**, colisões por **SDF** com velocidades de fronteira e remapeamento de domínio móvel sem teleporte de partículas;
  - **Atomics em WGSL (sem `atomicAdd` nativo em float):** comparar benchmark de acumulação P2G via `i32`/`u32` em ponto fixo (`Zarathos94/mls-mpm-gpu`) vs. loops *compare-and-swap* (`harri665/MPM`), testando estabilidade numérica do SVD contra `NaN`/`Inf`;
  - **Substep CFL próprio** (desacoplado dos 8,33 ms do Jolt) e **protocolo conservativo de massa:** terreno debita massa uma única vez → emite material points MPM (lembrando que 65k material points são *volumes* de ~4,6 cm, não grãos microscópicos!) → partículas escorrem sobre/sob geometrias 3D e empilham em cavidades/caçamba → reincorporação conservativa ao estabilizar. Inicialmente **sem devolver forças ao Jolt** (acoplamento bidirecional é pesquisa separada);
  - **Estudo complementar:** DEM localizado para milhares de pedregulhos/aglomerados (`Chrono DEM-Engine` / `veloxsim-dem-open`) e *LBM-MPM* (`DacianShaw/LBM-MPM-Air-Water-Sand`) para acoplamento futuro água–areia–ar na lama.
- **Perfis de Experimento & Profiling Real (`GPUDevice.limits`):**
  - *Validação:* `4.096–16.384` partículas em grade `32³` (matemática, plasticidade, conservação);
  - *Intermediário:* `32.768–65.536` partículas em `48³–64³` (~8 MiB só para grade principal);
  - *Estresse:* `131.072+` partículas em `64³–128³` (limites de atomics, memória e p95/p99 — meta experimental ≤ 3 ms em GPU dedicada para ativação automática no Ultra, sempre confirmada por benchmark real).

### 6.4 Matriz de Validação Científica (9 Testes de Aceitação) & Gates de Desempenho
Todo avanço de física/areia deve passar por **benchmarks reproduzíveis** (separando CPU, GPU, transferências, p95/p99 e heap WASM) e pelos **9 cenários de validação**:
1. **Pilha de areia:** formar cone e medir ângulo de inclinação, relaxamento e conservação de massa final.
2. **Colapso de coluna:** remover parede lateral e comparar geometria de espalhamento.
3. **Roda em areia solta:** medir *sinkage*, resistência, torque, *slip* e perfil do sulco.
4. **Passagens repetidas:** validar compactação progressiva entre 1ª e N-ésima passagem.
5. **Rocha parcialmente enterrada:** escavar sedimento até perder apoio e validar liberação dinâmica no Jolt.
6. **Obstáculo com vento:** validar erosão a barlavento e deposição a sotavento.
7. **Janela MPM móvel:** deslocar domínio repetidamente sem saltos, duplicações ou perda de massa.
8. **Carga extrema:** bursts prolongados de brushes, pedras e partículas sem queda de p99 ou leak WASM.
9. **Paridade CPU/GPU:** comparar cenas pequenas com referência CPU determinística.

---

## Ecossistema Open-Source Auditado & Papers de Referência

### Projetos Open-Source Classificados
| Papel | Projetos & Licenças | Uso no DuneFlow |
| :--- | :--- | :--- |
| **Instalar (Dependências Core)** | `jrouwe/JoltPhysics.js` (MIT), `gkjohnson/three-mesh-bvh` (MIT), `@takram/three-atmosphere` (MIT), `three/addons/csm/CSM.js` (MIT) | Física rígida 6-DOF/Shape-Cast, consultas geométricas/hulls, atmosfera física e sombras em cascata |
| **Protótipo / Port / Adaptação** | `YigitSalihEmecen/Engine_Sim` (MIT), `harri665/MPM` (MIT), `Zarathos94/mls-mpm-gpu` (MIT), `SamG-Coder/SandDune` (MIT), `weigert/SimpleWindErosion` (MIT), `three-fluid-fx` (MIT), `pmndrs/racing-game` (MIT), `PositionBasedDynamics` / *Ten Minute Physics* (MIT) | Áudio *Waveguide* em `AudioWorklet`, MLS-MPM 3D em WGSL (atomics/SVD), testes de conservação de massa, erosão eólica, fluido 2D e XPBD |
| **Referência Científica *(Não copiar GPL / C++ pesado)*** | `projectchrono/chrono` & `DEM-Engine` (BSD-3), `yuanming-hu/taichi_mpm` & `taichi_elements` (MIT), `VeloxSim/veloxsim-dem-open` (MIT), `Clocktown/Oasis` (MIT CUDA), `Inria Windblown Sand 2024`, `DacianShaw/LBM-MPM-Air-Water-Sand` (MIT), `RigsOfRods/rigs-of-rods` (**GPL — só conceito**), `larsblatny/matter` (**GPL — só conceito**) | Equações de SCM/drivetrain, contatos DEM, erosão ao redor de obstáculos, acoplamento água–areia–ar e topologia de chassi flexível |
| **Descartados** | `schteppe/cannon-es`, `ammo.js`, `dimforge/rapier3d` (vs. Jolt) | Jolt supera em estabilidade de *rock crawling* a 120 Hz, *Shape-Cast* nativo e `VehicleConstraint` |

### Trilha de Papers Fundamentais
1. *A Moving Least Squares Material Point Method with Displacement Discontinuity and Two-Way Rigid Body Coupling* (Hu et al., 2018)
2. *Drucker-Prager Elastoplasticity for Sand Animation* (Klár et al., 2016)
3. *Windblown Sand Around Obstacles* (Inria, 2024)
4. *Oasis: A Real-Time Hydraulic and Aeolian Erosion Simulation with Dynamic Vegetation* (2025)
5. *Numerical Homogenization of Sand from Grain-Level Simulations* (2025)
6. *Volume-Preserving LBM-MPM Coupling for Air-Water-Sand Mixtures* (SIGGRAPH 2026)
7. *A Modular Hypoplastic Constitutive Model for Granular Soils* (2025)
8. *Real-Time Rendering of Glinty Appearances* (Deliot & Belcour, 2023) & *Glinty Granular Materials* (2022)
9. *Augmented Vertex Block Descent* (SIGGRAPH 2025 — referência futura GPU)
10. *On Hybrid Lagrangian-Eulerian Simulation Methods* (Curso SIGGRAPH 2019)

---

## Filtro Anti-Realismo Bobo & O Que Evitar Agora

- **Não substituir o terreno inteiro por partículas MLS-MPM:** as cascatas toroidais + fluxo conservativo continuam ideais para dunas e sulcos extensos.
- **Não começar por DEM com milhões de grãos nem migrar toda a engine para WebGPU agora:** WebGPU/MPM entra como módulo experimental isolado de PC Ultra sem quebrar o núcleo WebGL2 estável.
- **Não confundir fluido visual com areia:** areia exige atrito interno, plasticidade (Drucker–Prager) e conservação de volume; não usar tixotropia em areia seca (substituída por *slip-sinkage*).
- **Não presumir benchmarks sem medir:** nunca prometer ms fixos em WebGPU/WASM sem profiling real por fase e percentis p95/p99.
- **Itens cosméticos cortados:** fulguritos decorativos, *heat haze* fullscreen embaçando nitidez, respingos permanentes na lente (*lens droplets*) e *Time-Lapse Eólico* gimmick.

---

## Sprints Recomendados de Execução *(PC-First)*

- **Sprint 0 — “Hardening, 120 Hz & Performance Base” *(fazer primeiro)*:** `0.1` (Build 404, Guard Band, Seam, Leaks) + `0.2` (Fixes de física atuais) + `0.3` (Draw Calls caminhão, Smoke Vertex Y, Terreno & Grama, Zero GC, Passo Fixo `THREE.Timer`, *Uber-Composite*) + `0.4` (Sync Clima/UI & Telemetria Real)
- **Sprint 1 — “Borracha Viva & Óptica de Contato”:** `1.1` (*Soft-Tire WPO / Sidewall Bulge* + *Tire Caking*) + `1.2` (Porosidade 4 Fases + AO Analítica + Micro-Shadowing + SSS Crista + *Sand Drift* em Rochas + Glints 4K) + `1.3` (*Physics Monitor* Canvas + Poeira por Dissipação)
- **Sprint 2 — “Núcleo `JoltPhysics.js` (WASM) & Off-Road Hardcore”:** `2.1` (Jolt 120 Hz + *Shape-Cast* + `MixedContactResolver`) + `2.2` (Diferenciais & Lockers) + `2.3` (*High-Centering* & Aragem) + `2.4` (Risco 10 PSI / *Rim-Strike* / *Debeading*) + `2.5` (*Solid Axle* & *Ladder-Frame Flex*) + `2.6` (Dano em Joules & Pedras Enterradas)
- **Sprint 3 — “Areia Conservativa & Paisagem Viva”:** `3.1` (`TerrainMaterialState`, Substrato Rígido & `SedimentMassLedger`) + `3.2` (*Slip-Sinkage*, *Chrono SCM*, Dilatância & *Rut-Wall Trapping*) + `3.3` (*Bow-Wave*, Avalanches Conservativas & V vs. U) + `3.4` (Zonas Heterogêneas, Erosão em Rochas *Inria 2024* & *Singing Sand*)
- **Sprint 4 — “Iluminação PC Ultra & Atmosfera Volumétrica”:** `4.1` (CSM 4 Cascatas + Clipmap Depth) + `4.2` (`@takram/three-atmosphere` + Sombras de Nuvens + Rebote Quente) + `4.3` (Poeira 6-Way + *Soft Depth-Fade* + Sombra `128²/256²` + Navier-Stokes 2D PC / Analítica Híbrido)
- **Sprint 5 — “Cinestesia, Áudio *Waveguide* + PhISEM & Controles PC”:** `5.1` (Câmera 2ª Ordem + *Horizon Roll-Blend* + *Driveline*/*Wheel-Hop*) + `5.2` (Motor *Waveguide* `Engine_Sim` + PhISEM em `AudioWorklet`) + `5.3` (Gamepad Analógico & *Force Feedback* Dual-Channel)
- **Sprint 6 — “Sandbox, Laboratório WebGPU/MLS-MPM & Validação”:** `6.1` (*Maxtrax*, Guincho XPBD, Reboque, Chuva 2D) + `6.2` (Debug Físico, Replays & Lab PC) + `6.3` (Protótipo WebGPU/TSL MLS-MPM 2D→3D + DEM) + `6.4` (Matriz de 9 Testes & Profiling p95/p99)
