/**
 * Structured representation of ROADMAP.md for the DuneFlow Dark-Mode Roadmap Viewer
 * and the standalone single-file HTML generator.
 */

export type SeverityLevel = 'CRÍTICO' | 'ALTO' | 'MÉDIO' | 'BAIXO';

export interface RoadmapChecklistItem {
  id: string;
  title: string;
  severity?: SeverityLevel;
  fileRef?: string;
  problem?: string;
  action?: string;
  details?: string[];
  tag?: string;
  completed?: boolean;
}

export interface RoadmapTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface RoadmapCallout {
  title: string;
  items: string[];
}

export interface RoadmapSubSection {
  id: string;
  code: string;
  title: string;
  summary?: string;
  items?: RoadmapChecklistItem[];
  tables?: RoadmapTable[];
  callout?: RoadmapCallout;
  paragraphs?: string[];
}

export interface RoadmapSection {
  id: string;
  indexLabel: string;
  navTitle: string;
  title: string;
  subtitle: string;
  rationale: string;
  phaseBadge?: string;
  subSections: RoadmapSubSection[];
}

export const ROADMAP_META = {
  brand: 'DuneFlow',
  documentTitle: 'DuneFlow — Roadmap de Evolução: Física Granular, Atmosfera & Telemetria SCM',
  lead: 'Documento consolidado com ideias de evolução para elevar a interação com a areia, o realismo atmosférico, a visualização científica SCM (Soil Contact Model) e as mecânicas emergentes off-road do DuneFlow.',
  operationalBase:
    'Base atual já operacional na engine: Cascatas toroidais em GPU (ToroidalCascade + passSimStep), terramecânica Bekker sem readback (SandTerramechanics), clipmap adaptativo (ClipmapGeometry + terrainSand), fumaça volumétrica instanciada (VolumetricSmokeSystem), partículas GPU (particlesRoost), iluminação híbrida quase-RT (AtmosphericIBL, VehicleReflectionSystem, PostProcessingPipeline), suspensão/dano 6-DOF e áudio Web Audio procedural.',
};

export const ROADMAP_SECTIONS: RoadmapSection[] = [
  {
    id: 'fundamentos',
    indexLabel: '00',
    navTitle: 'Fundamentos & Arquitetura',
    title: 'Fundamentos & Arquitetura do Motor',
    subtitle: 'Por que estas escolhas importam, escalabilidade PC-First e fronteira de 5 níveis físicos.',
    rationale:
      'Conecta a matemática invisível da engine diretamente ao que o usuário vê e sente, mantendo física determinística idêntica entre PC Ultra, Híbrido e Mobile.',
    subSections: [
      {
        id: 'fund-exemplos',
        code: 'A',
        title: 'Núcleo dos Exemplos Iniciais',
        summary:
          'Os quatro pilares que separam simulações físicas de verdade de jogos genéricos — expondo forças, deformação e cisalhamento em tempo real.',
        items: [
          {
            id: 'f-ex-1',
            title: 'Widget “Physics Monitor” (slip angle, slip ratio, soil shear resistance)',
            tag: 'Telemetria SCM',
            details: [
              'Como o SandTerramechanics já calcula afundamento de Bekker, slipRatio e arrasto por roda em tempo real (sem readback caro de GPU), expor esses valores no ControlDock dá transparência científica imediata.',
              'Reduzir o PSI de 36 para 12 ou engatar 4L mostra na hora a resistência ao cisalhamento subir e o afundamento cair.',
            ],
          },
          {
            id: 'f-ex-2',
            title: 'Toggle “Tire Track” com splines dinâmicas não-persistentes',
            tag: 'Diagnóstico 3D',
            details: [
              'Rastros deformados na areia escondem a história energética da manobra (pico de tração vs. escavação excessiva).',
              'Um buffer não-persistente de splines leves sobre o rastro resolve dois problemas juntos: custo de memória limitado (a fita desaparece atrás do carro) e leitura espacial clara do comportamento do chassi e do contact patch.',
            ],
          },
          {
            id: 'f-ex-3',
            title: 'Partículas GPU de sand dust disparadas por slipRatio e moduladas pelo cisalhamento',
            tag: 'Emissão Física',
            details: [
              'Em vez de poeira genérica baseada só na velocidade, amarrar o emissor GPU ao limiar de slipRatio e à resistência ao cisalhamento (τ) transforma a poeira em um indicador físico honesto.',
              'Em rolagem pura quase não há poeira; quando o solo rompe por cisalhamento, o jato explode proporcionalmente ao esforço do pneu.',
            ],
          },
          {
            id: 'f-ex-4',
            title: 'Fumaça realista com biblioteca ou replicação de solver de fluido',
            tag: 'Aerodinâmica',
            details: [
              'Em vez de dezenas de billboards estáticos independentes, replicar um solver leve de fluido 2D (estilo Stable Fluids / WebGL Fluid) traz conservação de momento e vorticidade para a esteira do carro.',
              'Faz a poeira girar em redemoinhos atrás da caçamba e responder ao vento lateral.',
            ],
          },
        ],
      },
      {
        id: 'fund-perfis',
        code: 'B',
        title: 'Filosofia PC-First & Perfis',
        summary:
          'O DuneFlow tem o PC Desktop como plataforma principal e nunca deve ter seu teto de realismo capado pelas limitações de celulares. A arquitetura opera com física determinística idêntica e 3 níveis reais de escalabilidade.',
        tables: [
          {
            caption: 'Escalabilidade Gráfica & Física em 3 Perfis',
            headers: ['Perfil', 'Alvo Principal', 'Estratégia Arquitetural'],
            rows: [
              [
                'Ultra (PC Desktop)',
                'GPUs dedicadas PC / telas 60–144 Hz',
                'Sem compromisso: núcleo rígido JoltPhysics.js (WASM 120 Hz), CSM 4 cascatas (2048²), cascatas toroidais 1024², Bent Normals no GTAO, atmosfera física (@takram/three-atmosphere) + sombras de nuvens, solver toroidal Navier-Stokes 2D real na esteira, sombras de poeira 256² a 60 Hz, torção tangencial (brush model) no pneu, Shallow Water 2D dedicado, áudio Waveguide 4 linhas + PhISEM 4 canais e modo experimental WebGPU/TSL (MLS-MPM granular local).',
              ],
              [
                'Híbrido (PC Mid / Mobile High)',
                'Notebooks, GPUs integradas & celulares topo',
                'Melhor relação realismo/ms: Jolt a 60–120 Hz, CSM 2 cascatas (1024²), pacote óptico completo (0 samplers extras no terreno), sidewall bulge + tire caking, poeira 6-way com soft depth-fade em meia resolução, sombra de poeira 128² a 30 Hz, esteira aerodinâmica analítica (dipolo + von Kármán + Curl Noise), Mip Fog (Uncharted 4) e pós-processamento em Uber-Composite.',
              ],
              [
                'Leve (Mobile Entry / Software GL)',
                'Celulares de entrada / bateria',
                'Cascatas 512² (8 MB VRAM), Jolt 60 Hz com corpo único (sem ladder-frame flex) e 3 pontos na banda, 1 shadow map direcional, sidewall bulge simplificado, escurecimento poroso + AO analítica, 6-way sem depth-fade (96 partículas), Waveguide 1 linha + PhISEM 2 canais — mantendo a essência da física de solo e tração.',
              ],
            ],
          },
        ],
      },
      {
        id: 'fund-niveis',
        code: 'C',
        title: '5 Níveis Físicos & Regras de Ouro',
        summary:
          'Para evoluir o DuneFlow para um simulador híbrido de materiais granulares sem duplicar areia nem provocar stalls de readback GPU, o motor opera em 5 camadas com fronteira clara de autoridade.',
        tables: [
          {
            caption: 'Camadas Autoritativas da Simulação',
            headers: ['Nível', 'Sistema Autoritativo', 'Frequência / Domínio', 'Papel na Simulação'],
            rows: [
              [
                'Nível 1 — Mundo Rígido & Veículo',
                'JoltPhysics.js (WASM)',
                '120 Hz fixos (PC) / 60 Hz (Leve)',
                'Chassi composto CCD 6-DOF, Solid Axle, Ladder-Frame Flex, rochas, peças soltas, Maxtrax e reboque',
              ],
              [
                'Nível 2 — Solo Mecanicamente Autoritativo',
                'Bekker/SCM + TerrainMaterialState + MixedContactResolver',
                '120 Hz CPU (zero GPU readback)',
                'Contatos multiponto (areia + rocha simultâneos sem duplicar força), compactação, slip-sinkage, high-centering e diferenciais',
              ],
              [
                'Nível 3 — Terreno Conservativo de Grande Escala',
                'ToroidalCascade + SedimentMassLedger',
                'GPU ping-pong + sync verificável',
                'Espessura sobre substrato rígido, conservação de massa (Mᵢ = ρ_b,i · Aᵢ · hᵢ), avalanches conservativas e erosão eólica',
              ],
              [
                'Nível 4 — Volume Granular Localizado (Experimental PC)',
                'WebGPU + TSL (LocalMPM / DEM)',
                'Substeps CFL independentes (PC Ultra)',
                'Areia 3D real perto de pneus/rochas/cavidades (inicialmente sem autoridade de força sobre o Jolt; acoplamento bidirecional é pesquisa separada)',
              ],
              [
                'Nível 5 — Óptica, Iluminação & Áudio',
                'Three.js r187 + AudioWorklet',
                '60–144 FPS + 48 kHz áudio',
                'CSM, atmosfera física, glints 4K estáveis, rebote quente, poeira 6-way, Waveguide + PhISEM e Gamepad FFB',
              ],
            ],
          },
        ],
        callout: {
          title: 'Regras de Ouro WebGL2 / WebGPU / Three.js r187',
          items: [
            '1. Zero GPU readbacks síncronos no loop principal de física (120 Hz).',
            '2. Conservação de massa & sincronização: areia escavada precisa aparecer em outro lugar ou virar partículas debitadas uma única vez (nunca criar duas cópias independentes da mesma areia); compactação não é perda de massa.',
            '3. Precisão RGBA16F: manter a ToroidalCascade estritamente em deltas relativos (±1,5 m, ULP ≤ 1 mm), nunca sobre cota absoluta do terreno.',
            '4. Cota de samplers do terreno: manter o fragment shader do clipmap abaixo de 16 MAX_TEXTURE_IMAGE_UNITS derivando porosidade, micro-shadowing, AO analítica e translucidez da ToroidalCascade e uniforms.',
            '5. Passo físico fixo (120 Hz via THREE.Timer): obrigatório para estabilidade em monitores PC de 120–240 Hz; o substep CFL do MPM é desacoplado dos 8,33 ms do Jolt.',
          ],
        },
      },
      {
        id: 'fund-fases',
        code: 'D',
        title: 'Lógica & Visão Geral das Fases',
        summary:
          'As 7 fases (Fase 0 à Fase 6) seguem uma progressão onde cada etapa gera ganho físico e visual mensurável antes da seguinte.',
        tables: [
          {
            caption: 'Resumo Executivo das 7 Fases',
            headers: ['Fase', 'Foco Principal', 'Resultado Esperado'],
            rows: [
              [
                'Fase 0 — Hardening, Física & Performance (Auditoria)',
                '38 pontos da auditoria + passo fixo 120 Hz + Uber-Composite TBDR + three-mesh-bvh',
                'Build de produção íntegro, base sem vazamentos e grande folga de GPU/CPU',
              ],
              [
                'Fase 1 — Pneu Vivo, Óptica Granular & Visibilidade SCM',
                'Soft-Tire WPO / Sidewall Bulge + Tire Caking + Pacote Óptico + Sand Drift em rochas + glints 4K',
                'Borracha viva, carro ancorado no solo, junção orgânica rocha–areia e telemetria SCM',
              ],
              [
                'Fase 2 — Núcleo JoltPhysics.js (WASM) & Física Off-Road Hardcore',
                'CCD 6-DOF, Shape-Cast + contato misto, diferenciais/lockers, high-centering, debeading, eixo rígido e chassis flex',
                'Colisões 3D impecáveis, rock crawling autêntico, atolamento real e dano em Joules',
              ],
              [
                'Fase 3 — Geomecânica Conservativa & Evolução da Paisagem',
                'TerrainMaterialState, SedimentMassLedger, slip-sinkage, Chrono SCM, rut-wall trapping, avalanches conservativas e erosão eólica',
                'Areia com memória histórica e conservação de massa que “briga” com o volante',
              ],
              [
                'Fase 4 — Iluminação PC Ultra, Atmosfera & Poeira Volumétrica',
                'CSM 4 cascatas + @takram/three-atmosphere + sombras de nuvens + GI quente + poeira 6-way/sombra + fluido 2D PC',
                'Visual de referência PC Ultra (1440p/4K) com degradação limpa no Híbrido/Mobile',
              ],
              [
                'Fase 5 — Cinestesia de Peso, Áudio Waveguide + PhISEM & FFB PC',
                'Câmera 2ª ordem + Horizon Roll-Blend + Waveguide (Engine_Sim) + PhISEM (AudioWorklet) + Gamepad/Volante FFB',
                'Sensação tátil e sonora completa de 2 toneladas + controle analógico fino',
              ],
              [
                'Fase 6 — Sandbox Off-Road, Lab WebGPU/MLS-MPM & Validação',
                'Maxtrax, guincho XPBD, reboque 2 rodas, chuva 2D, Lab PC, protótipo MLS-MPM 3D / DEM WebGPU e 9 testes científicos',
                'Sandbox off-road completo + fronteira experimental de areia 3D volumétrica calibrada',
              ],
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-0',
    indexLabel: '01',
    navTitle: 'Fase 0 — Hardening',
    title: 'Fase 0 — Hardening, Correções de Física & Performance',
    subtitle: 'Auditoria técnica completa dos 29 arquivos-fonte: 38 achados organizados por área e severidade.',
    rationale:
      'Empilhar fluido 2D, novas camadas de solo e widgets científicos sobre bugs de física ou shaders sobrecarregados multiplicaria retrabalho e derrubaria o FPS no celular.',
    phaseBadge: 'Auditoria Técnica',
    subSections: [
      {
        id: 'f0-1',
        code: '0.1',
        title: 'Build, Rendering & Vazamentos de Memória',
        summary: 'Correções de assets em produção, guard band toroidal, emendas UV, sombras analíticas e limpeza de recursos WebGL2.',
        items: [
          {
            id: 'f0-1-1',
            severity: 'CRÍTICO',
            completed: true,
            title: 'Texturas fotográficas da areia com 404 em produção',
            fileRef: 'WebSandAdapter.ts:577, 595',
            problem:
              "texLoader.load('/src/assets/images/...') usa paths literais de dev que o Vite não copia para dist/ no npm run build (caindo no fallback borrado 128×128), além de sandstone_strata_albedo_1795181775786.jpg (1,2 MB) estar sem uso.",
            action:
              'Importar via ES Module (import ... from "../../assets/images/...") ou mover para public/assets/images/ e remover o ativo órfão.',
          },
          {
            id: 'f0-1-2',
            severity: 'ALTO',
            completed: true,
            title: 'Vazamento na borda do guard band toroidal',
            fileRef: 'passSimStep.ts:128-140',
            problem:
              'if (inGuard || outsidePrev) promove rastros da uParentCascade dentro da faixa de guarda de 2 texels em vez de zerá-los, vazando sulcos para o lado oposto da janela de 32 m durante a avalanche.',
            action: 'Zerar vec4(0.0) quando inGuard e promover da cascata pai somente quando outsidePrev && !inGuard.',
          },
          {
            id: 'f0-1-3',
            severity: 'ALTO',
            completed: true,
            title: 'Emenda (seam) na textura procedural da lama',
            fileRef: 'MudTextureGenerator.ts:110',
            problem:
              'valueNoisePeriodic(u * 0.5 + v * 0.14, v * 2.0, 12, 313) usa períodos fracionários (6 e 1,68), criando cortes visíveis a cada wrap de UV.',
            action: 'Ajustar multiplicadores para inteiros compatíveis com o período 12.',
          },
          {
            id: 'f0-1-4',
            severity: 'ALTO',
            completed: true,
            title: 'Sombra analítica e AO das rodas coladas no chão durante saltos e capotagens',
            fileRef: 'terrainSand.ts:624-655',
            problem:
              'underBodyAO e wheelAO checam apenas distância horizontal XZ (ignorando altura Y e rotação do chassi); no fallback sem shadow map, ro.y é clampado em [-0.45, 0.45].',
            action: 'Atenuar contato/sombra por altura acima do solo (clearanceY) e desativar wheelAO quando capotado.',
          },
          {
            id: 'f0-1-5',
            severity: 'ALTO',
            completed: true,
            title: 'Divergência de pixelRatio e resize incompleto no mobile',
            fileRef: 'WebSandAdapter.ts:382-386, 771, 1991 · PostProcessingPipeline.ts:472-476',
            problem:
              'Em telas < 768px, o renderer usa DPR até 1.75 enquanto o composer/GTAO usa 1.5; ao rotacionar o celular, handleResize nunca atualiza renderer.setPixelRatio nem uPixelRatio das partículas (roostParticles / sparkParticles).',
            action: 'Centralizar cálculo de pixelRatio e atualizar renderer, pipeline e uniforms de partículas juntos no handleResize.',
          },
          {
            id: 'f0-1-6',
            severity: 'ALTO',
            completed: true,
            title: 'Vazamentos de recursos GPU no ciclo de vida',
            fileRef: 'DesertEnvironment.ts:61-63, 97 · WebSandAdapter.ts:355-356, 576-607, 2095-2148',
            problem:
              'Mesh Sky morto é atualizado todo frame e nunca descartado; pendingSimQuery/pendingFrameQuery nunca recebem gl.deleteQuery(); callbacks assíncronos de texLoader.load podem vazar texturas se concluírem após dispose() (ex.: React StrictMode).',
            action:
              'Remover o Sky não utilizado, deletar WebGLQuery no dispose() e proteger callbacks de textura com if (this.disposed) { loaded.dispose(); return; }.',
          },
          {
            id: 'f0-1-7',
            severity: 'MÉDIO',
            completed: true,
            title: 'Faíscas sem tone-mapping/gamma no modo direto',
            fileRef: 'particlesRoost.ts:497-529',
            action:
              'Adicionar uniform uLinearHdrOutput e ACES + sRGB encode no SPARK_PARTICLES_FRAG quando pós-processamento HDR estiver desligado.',
          },
          {
            id: 'f0-1-8',
            severity: 'MÉDIO',
            completed: true,
            title: 'Grama amassada/animada projeta sombra estática e levanta aos 16 m',
            fileRef: 'GrassFieldSystem.ts:330',
            action:
              'Remover castShadow da grama (usar AO de base), inicializar uGrassCascade0 com textura válida e integrar fallback da Cascade 1 se necessário.',
          },
          {
            id: 'f0-1-9',
            severity: 'MÉDIO',
            completed: true,
            title: 'Degraus abruptos e bound subestimado nas lajes de pedra escaláveis',
            fileRef: 'DesertObstacles.ts:149, 200',
            action: 'Envelopar facetNoise para zerar suavemente antes de r² = 1.24 e usar Math.hypot(halfX, halfZ) * 1.25 no raio de bound.',
          },
          {
            id: 'f0-1-10',
            severity: 'MÉDIO',
            completed: true,
            title: 'Anel de horizonte (ergDuneMesh) intercepta dunas externas além de 70 m',
            fileRef: 'DesertEnvironment.ts:737 · TerrainHeightfield.ts:98-99',
            action: 'Alinhar elevação/transição do anel de horizonte ao heightfield ou ancorar o outerRise em relação ao envelope de borda.',
          },
          {
            id: 'f0-1-11',
            severity: 'MÉDIO',
            completed: true,
            title: 'Arranhões metálicos escurecem a pintura em vez de parecer aço',
            fileRef: 'VehicleCrashPhysics.ts:738-746',
            action:
              'Separar máscara de raspagem (ou boost de metalness/cor clara via atributo/shader) em vez de multiplicar vertex color (0.62, 0.64, 0.67) sobre albedo escuro #7e170d.',
          },
          {
            id: 'f0-1-12',
            severity: 'BAIXO',
            completed: true,
            title: 'Facho dos faróis no terreno ignora pitch/roll do veículo',
            fileRef: 'terrainSand.ts:675-715',
            action: 'Passar vetor 3D uVehicleFwd3D (com pitch/roll reais) no lugar de uVehicleFwd 2D para inclinar o facho em subidas, saltos e capotagens.',
          },
        ],
      },
      {
        id: 'f0-2',
        code: '0.2',
        title: 'Física, Dinâmica Veicular & Terramecânica',
        summary: 'Correções de sinal em ré, Coriolis no ar, sincronização entre suspensão e capotagem, colisões 3D e telemetria limpa de saltos.',
        items: [
          {
            id: 'f0-2-1',
            severity: 'CRÍTICO',
            completed: true,
            title: 'Arrasto de esterçamento com sinal invertido em marcha ré',
            fileRef: 'VehicleSuspensionPhysics.ts:439 / VehicleRig.ts:930',
            problem:
              'fFwdChassis = -fTireLat * sinS * dirSign inverte o sinal duas vezes em ré (dirSign = -1), fazendo a força lateral do pneu acelerar o caminhão para trás ao virar o volante em ré.',
            action: 'Corrigir para fFwdChassis = -fTireLat * sinS e cobrir com teste unitário (node:test).',
          },
          {
            id: 'f0-2-2',
            severity: 'ALTO',
            completed: true,
            title: 'Sinal de pitchVel invertido no impacto de capotagem',
            fileRef: 'VehicleCrashPhysics.ts:348-351',
            problem:
              'probeHitVy soma + state.pitchVel * worstProbe.lz * 0.45, mas +pitchVel move +lz (frente) para baixo (-Y), atenuando impactos frontais e exagerando impactos traseiros.',
            action: 'Inverter o termo para - state.pitchVel * worstProbe.lz * 0.45 (com projeção cosPitch/sinPitch).',
          },
          {
            id: 'f0-2-3',
            severity: 'ALTO',
            completed: true,
            title: 'Rotação de referencial (Coriolis) incompleta faz momento linear girar “de graça” no ar',
            fileRef: 'VehicleRig.ts:954',
            problem:
              'vLateral -= this.yawRate * vForward * safeDt * 0.14 aplica apenas 14% do termo cinemático e omite a rotação de vForward, permitindo redirecionar a trajetória no meio de um salto ou deslizando de teto.',
            action:
              'Integrar velocidade em coordenadas de mundo (vx, vz) e decompor em (vForward, vLateral) a cada passo (ou rotacionar o vetor completo por -yawRate * safeDt).',
          },
          {
            id: 'f0-2-4',
            severity: 'ALTO',
            completed: true,
            title: 'Conflito entre solvers de suspensão vs. capotagem e slerp dependente de FPS',
            fileRef: 'VehicleRig.ts:1102-1125, 1542-1589 · VehicleSuspensionPhysics.ts:175',
            problem:
              'Trocar rolloverActive dá salto súbito em totalComY e zera chassisComVy; slerp(..., 0.55) e slerp(..., 0.72) mudam comportamento entre 60 Hz e 120 Hz.',
            action: 'Sincronizar altura e velocidade vertical nas transições de estado e substituir fatores fixos de slerp por 1 - Math.exp(-k * dt).',
          },
          {
            id: 'f0-2-5',
            severity: 'ALTO',
            completed: true,
            title: 'Peças soltas ejetadas em direção errada quando heading != 0',
            fileRef: 'VehicleRig.ts:499-507',
            problem: 'impact.localNormalX/Z (espaço local) são somados diretamente à velocidade mundial do caminhão.',
            action: 'Rotacionar o vetor normal de impacto por this.heading antes de somar a this.velocity.',
          },
          {
            id: 'f0-2-6',
            severity: 'MÉDIO',
            completed: true,
            title: 'Rodas no ar ainda reportam carga mínima (450 N) e afundamento mínimo (8 mm)',
            fileRef: 'VehicleRig.ts:812 · SandTerramechanics.ts:314',
            action: 'Zerar normalLoadN e sinkage quando groundContact01[i] <= 0.01, limpando a telemetria de saltos (essencial para o Physics Monitor da Fase 1).',
          },
          {
            id: 'f0-2-7',
            severity: 'MÉDIO',
            completed: true,
            title: 'Colisões de rochas são cilindros 2D infinitos em Y + amortecimento dependente de FPS',
            fileRef: 'DesertObstacles.ts:289-358 · VehicleRig.ts:967',
            action: 'Verificar altura do chassi contra o topo da rocha (yMin/yMax) e usar Math.pow(0.88, dt * 60) no amortecimento de contato.',
          },
          {
            id: 'f0-2-8',
            severity: 'MÉDIO',
            completed: true,
            title: 'Carga estática hardcoded (staticLoad = 8460) na suspensão',
            fileRef: 'VehicleSuspensionPhysics.ts:77, 104',
            action: 'Derivar dinamicamente de (sprungMassKg / 4 + unsprungMassKg) * 9.81.',
          },
          {
            id: 'f0-2-9',
            severity: 'MÉDIO',
            completed: true,
            title: 'Personagens (Runners) atravessam pedras escaláveis',
            fileRef: 'RunnerRig.ts:226, 289',
            action: 'Trocar getBaseTerrainHeight por sampleSurfaceAt (incluindo CLIMBABLE_ROCK_SLABS).',
          },
          {
            id: 'f0-2-10',
            severity: 'BAIXO',
            completed: true,
            title: 'RunnerRig consulta o ring buffer mesmo para o pé no ar',
            fileRef: 'RunnerRig.ts:292',
            action: 'Consultar queryFootSinkage somente quando o pé estiver em fase de apoio (stance).',
          },
        ],
      },
      {
        id: 'f0-3',
        code: '0.3',
        title: 'Otimização Estrutural (GPU, CPU/GC, Mobile & React)',
        summary: 'Corte drástico de draw calls, remoção de trigs em pixel shaders, zero GC churn, passo fixo 120 Hz via THREE.Timer e Uber-Composite TBDR.',
        items: [
          {
            id: 'f0-3-1',
            severity: 'CRÍTICO',
            completed: true,
            title: 'Redução de ~200+ para ~20 draw calls no caminhão',
            fileRef: 'VehicleMeshBuilder.ts',
            problem:
              'Porcas, raios, barras, parafusos e as 5 rodas são meshes separados sem merge nem geometria compartilhada, gerando ~450–700 draw calls/frame entre Shadow, Beauty, Retrovisores e CubeCamera.',
            action: 'Aplicar mergeGeometries por grupo/material (mantendo separadas apenas as peças móveis/destacáveis) e compartilhar geometria entre as 5 rodas.',
          },
          {
            id: 'f0-3-2',
            severity: 'CRÍTICO',
            completed: true,
            title: 'Remover 25 trigs/pixel do terreno no fragment shader da fumaça',
            fileRef: 'particlesRoost.ts:258',
            problem: 'VOLUMETRIC_SMOKE_FRAG avalia getBaseTerrainHeight(vWorldPos.xz) em todo fragmento sobreposto (até 480 puffs com alto overdraw).',
            action: 'Passar vGroundY calculado no vertex shader (particlesRoost.ts:115) como varying, zerando o custo de terreno por pixel.',
          },
          {
            id: 'f0-3-3',
            severity: 'CRÍTICO',
            completed: true,
            title: 'Eliminar shadow pass e culling desligado dos 133.200 triângulos de grama',
            fileRef: 'GrassFieldSystem.ts:321-332',
            problem: '7.400 tufos DoubleSide com castShadow = true e frustumCulled = false duplicam 133k triângulos todo frame.',
            action: 'Desligar castShadow, reduzir densidade no mobile e atualizar bounding sphere centrado no veículo para reabilitar frustum culling.',
          },
          {
            id: 'f0-3-4',
            severity: 'ALTO',
            completed: true,
            title: 'Podar texture fetches e trigs desperdiçados no shader do terreno',
            fileRef: 'terrainSand.ts:171-337, 546-588, 781, 790-925',
            problem: '~43 texture fetches + ~100 trigs + ~70 hashes por pixel — incluindo fetches de detalhe normal a >15 m onde o peso é 0.0 e 12 fetches de evalMicroSelfShadow em areia lisa.',
            action:
              'Colocar early-outs por distância/peso (if (midGrainFade > 0.01), if (atten > 0.01)), pular evalMicroSelfShadow quando depression + bermMass < 0.004 e mover N_base de anéis distantes para o vertex shader.',
          },
          {
            id: 'f0-3-5',
            severity: 'ALTO',
            completed: true,
            title: 'Perfil adaptativo de VRAM/GTAO para mobile',
            fileRef: 'WebSandAdapter.ts:456 · PostProcessingPipeline.ts:378-405',
            problem: 'Celulares alocam cascatas 1024×1024 RGBA16F (32 MB, 2,1M fragmentos/frame) e rodam GTAOPass + Poisson Denoise em resolução nativa completa no modo hybrid.',
            action: 'Usar 512×512 em dispositivos mobile e rodar GTAO em meia resolução (rw / 2, rh / 2) — liberando margem térmica para o Fluido 2D.',
          },
          {
            id: 'f0-3-6',
            severity: 'ALTO',
            completed: true,
            title: 'Eliminação de GC churn nos hot-loops de física e render',
            fileRef: 'WebSandAdapter.ts · VehicleSuspensionPhysics.ts · VehicleCrashPhysics.ts · VehicleRig.ts · VehicleReflectionSystem.ts',
            problem: 'Milhares de arrays, closures e objetos de probe alocados por segundo + 8 amostras redundantes de sampleSurfaceAt em syncVisualTransform.',
            action: 'Pré-alocar scratch buffers tipados como campos da instância, usar métodos bound para callbacks de partículas/áudio e reaproveitar as amostras de terreno já calculadas no step().',
          },
          {
            id: 'f0-3-7',
            severity: 'ALTO',
            completed: true,
            title: 'Passo físico fixo via THREE.Timer, Uber-Composite TBDR & Recursos Three.js r187',
            fileRef: 'PC 120/144 Hz & WebGL2 Hygiene',
            details: [
              'Passo fixo: Migrar o acumulador de física/suspensão/câmera para passo fixo (60 Hz / 120 Hz com clamp dt ≤ 33 ms) usando THREE.Timer (r187), evitando instabilidade de suspensão/câmera em monitores PC de 120–240 Hz.',
              'Uber-Composite & TBDR: Fundir passes finais de PostProcessingPipeline em um único passe uber-composite com triângulo fullscreen único e chamar gl.invalidateFramebuffer() em anexos transitórios ao fim do frame.',
              'Alinhamento r187 & BVH: Aproveitar o BRDF difuso EON nativo de MeshPhysicalMaterial (Three.js r187) em rochas/detritos, avaliar SunLight com cascatas no PC Ultra e adotar three-mesh-bvh para shapecasts rápidos.',
            ],
          },
          {
            id: 'f0-3-8',
            severity: 'MÉDIO',
            completed: true,
            title: 'Evitar chamada de updateHeadlightsForWeather todo frame',
            fileRef: 'WebSandAdapter.ts:1777',
            action: 'Disparar apenas quando weatherPreset, biome ou estado de quebra de farol mudar.',
          },
          {
            id: 'f0-3-9',
            severity: 'MÉDIO',
            completed: true,
            title: 'Rejeição rápida por AABB no ring buffer da terramecânica',
            fileRef: 'SandTerramechanics.ts:222-250',
            action: 'Guardar min/max XZ por segmento para descartar rapidamente segmentos distantes no loop O(512).',
          },
          {
            id: 'f0-3-10',
            severity: 'MÉDIO',
            completed: true,
            title: 'Suspender AudioContext ao silenciar + reutilizar buffer de impacto',
            fileRef: 'VehicleAudioEngine.ts:59-68, 357',
            action: 'Chamar ctx.suspend()/ctx.resume() no mute e pré-alocar um AudioBuffer de ruído compartilhado para colisões.',
          },
          {
            id: 'f0-3-11',
            severity: 'BAIXO',
            completed: true,
            title: 'Isolar re-renders de telemetria no React',
            fileRef: 'App.tsx:32, 102-104',
            action: 'Aplicar React.memo no MobileDrivePad e nas abas estáticas do ControlDock, ou separar o readout numérico em componente isolado.',
          },
        ],
      },
      {
        id: 'f0-4',
        code: '0.4',
        title: 'Sincronização de Estado, Acessibilidade/UX & Telemetria Honesta',
        summary: 'Consistência entre estado da engine e UI React, acessibilidade de toque/teclado e métricas reais na aba Orçamento.',
        items: [
          {
            id: 'f0-4-1',
            severity: 'ALTO',
            completed: true,
            title: 'Dessincronização de clima e exposição ao trocar bioma',
            fileRef: 'ControlDock.tsx:600-608 · WebSandAdapter.ts:1008-1016',
            problem:
              'Trocar para Lama & Grama muda internamente weatherPreset para humid_overcast e exposure na engine sem avisar o React (o botão Golden Hour continua aceso na UI).',
            action: 'Incluir weatherPreset e exposure no patch disparado pela UI ou emitir callback onConfigSync da engine para o React (unificando também goToRockTrail()).',
          },
          {
            id: 'f0-4-2',
            severity: 'MÉDIO',
            completed: true,
            title: 'Acessibilidade dos botões 4H/4L / PSI e proteção touch em tablets',
            fileRef: 'MobileDrivePad.tsx:220, 243 · ControlDock.tsx:735-820',
            action: 'Suportar ativação por teclado (onKeyDown/click acessível sem duplo disparo) no MobileDrivePad e estender o guard não-passivo de touchstart para a barra hold-to-drive em tablets.',
          },
          {
            id: 'f0-4-3',
            severity: 'BAIXO',
            completed: true,
            title: 'Corrigir métricas hardcoded/imprecisas na aba Orçamento',
            fileRef: 'ControlDock.tsx:299, 1310 · WebSandAdapter.ts:1906, 1968',
            action:
              'Exibir capacidade real do ring buffer (/512 seg), resolução/VRAM real das cascatas (2× 512² = 8 MB vs 2× 1024² = 32 MB) e indicar claramente quando EXT_disjoint_timer_query_webgl2 não estiver disponível em vez de somar + 0.78 ms.',
          },
        ],
      },
    ],
  },

  {
    id: 'fase-1',
    indexLabel: '02',
    navTitle: 'Fase 1 — Pneu & Óptica',
    title: 'Fase 1 — Pneu Vivo, Contato Óptico & Visibilidade SCM',
    subtitle: 'Maior salto perceptivo por custo: borracha viva por PSI, pacote óptico com 0 samplers extras e telemetria SCM.',
    rationale:
      'Fecha as duas lacunas visuais mais fortes atuais: mudar de 36 para 10 PSI altera a física mas o pneu continua um cilindro rígido, e o encontro borracha–solo depende só de shadow map/GTAO.',
    phaseBadge: 'Maior Salto Perceptivo',
    subSections: [
      {
        id: 'f1-1',
        code: '1.1',
        title: 'Deformação Analítica da Carcaça (Soft-Tire WPO + Sidewall Bulge) & Tire Caking',
        summary: 'Vende instantaneamente que o pneu tem borracha, ar e 2 toneladas em cima — visível na câmera principal, na GoPro Roda, no CubeCamera e nos retrovisores sem draw calls extras.',
        items: [
          {
            id: 'f1-1-1',
            title: 'Rigidez vertical pneumática (Wong) & deflexão física',
            tag: 'Equação Base',
            details: [
              'Rigidez: k_z(PSI) = k_carcass + c_p · PSI (ex.: k_carcass ≈ 45 kN/m, c_p ≈ 6,5 kN/(m·PSI) para pneu 33").',
              'Deflexão: δ = clamp(F_z / k_z, 0, 0,65·H) — cerca de ~1,9 cm a 36 PSI contra ~4,7–10,5 cm a 10 PSI.',
            ],
          },
          {
            id: 'f1-1-2',
            title: 'Preservação do aro rígido + Achatamento C¹ da banda + Bojo lateral',
            tag: 'Vertex Shader',
            details: [
              'Preservação do aro rígido (m_rim): máscara radial smoothstep mantendo a roda metálica perfeitamente circular.',
              'Achatamento C¹ da banda + Bojo lateral (Δw ≈ 0,55·δ): vértices abaixo de y_c = -R₀ + δ achatam suavemente via smooth-max alinhado à normal local do solo, enquanto o flanco estufa no eixo x_hub com recálculo analítico de normal.',
            ],
          },
          {
            id: 'f1-1-3',
            title: 'Armadilhas evitadas & sincronização de sombra',
            tag: 'Higiene Shader',
            details: [
              'Manter mesh.rotation.x = 0 e aplicar uSpinAngle dentro do vertex shader antes do achatamento no espaço local da manga de eixo em highp float (impede achatamento girando com a roda e quantização longe da origem).',
              'Sincronizar o mesmo WPO no customDepthMaterial para não descolar a sombra.',
            ],
          },
          {
            id: 'f1-1-4',
            title: 'Tire Caking acoplado & escalabilidade 3 níveis',
            tag: 'Borracha & Lama',
            details: [
              'Máscara de cavidade nos cravos controlada por uCakeLevel[4]: enche na lama/areia úmida e limpa pela aceleração centrífuga ω²R₀ arremessando torrões.',
              'Escalabilidade: Leve (achatamento + bojo sem recálculo de normal) · Híbrido (completo + customDepthMaterial + tire caking) · Ultra PC (+ torção tangencial da banda por modelo brush proporcional ao torque e slipAngle β).',
            ],
          },
        ],
      },
      {
        id: 'f1-2',
        code: '1.2',
        title: 'Pacote Óptico de Contato, Areia AAA & Acúmulo em Rochas (0 Samplers Extras)',
        summary: 'Transforma a leitura de peso, micro-superfície e profundidade dos sulcos sob qualquer ângulo solar usando apenas os canais já amostrados da ToroidalCascade + uniforms leves.',
        items: [
          {
            id: 'f1-2-1',
            title: '1. Estratificação Subsuperficial & Escurecimento Poroso em 4 Fases (Lagarde + Uncharted 4)',
            tag: 'Porosidade & Umidade',
            details: [
              'Expõe areia subsuperficial mais escura e saturada no fundo do rastro (depression + compaction), transitando entre (D) seco → (C) poroso escuro e fosco (sem brilho plástico artificial) → (B) filme de tensão superficial suavizando rugosidade → (A) poça plana com normal forçada para (0, 1, 0).',
              'Liga compactação e umidade às propriedades ópticas e mecânicas simultaneamente.',
            ],
          },
          {
            id: 'f1-2-2',
            title: '2. Oclusão Analítica de Contato Pneu–Chassi (Grounding AO, Iñigo Quílez)',
            tag: 'Ancoragem',
            details: [
              '4 elipsoides (rodas) + 1 cápsula (chassi) avaliados apenas no raio de 6 m (early branch no resto da tela).',
              'Compostos multiplicativamente V_total = ∏ (1 - A_k) apenas na luz indireta (IBL) e combinados com min(aoGTAO, aoAnalytic) para nunca gerar dupla oclusão.',
            ],
          },
          {
            id: 'f1-2-3',
            title: '3. Micro-Shadowing Direcional de Sulcos (Call of Duty: WWII) + Oclusão Especular (Filament)',
            tag: 'Contraste de Sulcos',
            details: [
              'Usa o Laplaciano negativo dos 4 taps já lidos da ToroidalCascade para escurecer frestas no terminador solar e eliminar vazamento especular dentro de cavidades.',
            ],
          },
          {
            id: 'f1-2-4',
            title: '4. Translucidez Rasante em Cristas (Journey) + Bent Normals no PC Ultra',
            tag: 'SSS & IBL',
            details: [
              'A convexidade positiva do mesmo Laplaciano cria brilho âmbar translúcido em cristas e lábios de berms contra o sol.',
              'No Ultra PC, ativa saída de Bent Normals no GTAOPass (Jimenez 2016) inclinando a amostragem do AtmosphericIBL para fora das paredes do sulco.',
            ],
          },
          {
            id: 'f1-2-5',
            title: '5. Acúmulo de Areia na Base das Rochas (Wind-Blown Sand Drift)',
            tag: 'Junção Rocha–Areia',
            details: [
              'No shader das rochas, usar Height-Lerping combinando altura relativa ao terreno + ângulo de repouso (θ < 33°) + ruído direcional de vento para fundir organicamente a base da pedra com o material exato da areia, eliminando a linha dura de interseção poligonal.',
            ],
          },
          {
            id: 'f1-2-6',
            title: '6. Glints Deliot–Belcour Estáveis em 1440p/4K + Microcristas Barlavento/Sotavento',
            tag: 'Micro-Superfície',
            details: [
              'Adicionar mipmap bias dinâmico baseado em fwidth(vUv) e filtro espaço-temporal nos glints (sem ruído pixelado à distância), campo espacial de tamanho aparente de grão modulando roughness/densidade de glints, bordas irregulares de sulcos e distinção visual entre face barlavento (suave) e sotavento (slip-face).',
            ],
          },
        ],
      },
      {
        id: 'f1-3',
        code: '1.3',
        title: 'Widget “Physics Monitor (SCM)”, Poeira por Slip & Overlay Diagnóstico',
        summary: 'Exposição visual imediata da mecânica do solo sem poluir a tela nem provocar DOM thrashing.',
        items: [
          {
            id: 'f1-3-1',
            title: 'Physics Monitor (SCM) em Canvas 2D',
            tag: '15–20 Hz Zero-DOM',
            details: [
              'Mini-diagrama 4×4 colapsável (FL, FR, RL, RR) exibindo slipAngle, slipRatio, resistência ao cisalhamento τ, afundamento z, arrasto de compactação R_c vs. bulldozing R_b e sparkline motriz × resistência — oculto por padrão e desenhado em Canvas 2D.',
            ],
          },
          {
            id: 'f1-3-2',
            title: 'Partículas GPU de Poeira Moduladas por Dissipação Física',
            tag: 'Janosi-Hanamoto',
            details: [
              'Taxa de emissão e opacidade vinculadas à dissipação real (max(0, slipRatio - 0.12) × cisalhamento de Janosi-Hanamoto e 2,5× em Fesh-Fesh), separando claramente poeira fina de grãos balísticos grandes.',
            ],
          },
          {
            id: 'f1-3-3',
            title: 'Overlay “Tire Track” (Modo Diagnóstico Opcional)',
            tag: 'Toggle Engenharia',
            details: [
              'Mantido como toggle opcional de engenharia/telemetria (desligado por padrão para preservar imersão diegética), desenhando fitas 3D leves com largura do contact patch e cor por eficiência de cisalhamento.',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-2',
    indexLabel: '03',
    navTitle: 'Fase 2 — JoltPhysics.js',
    title: 'Fase 2 — Núcleo Físico Hardcore (JoltPhysics.js WASM) & 6-DOF',
    subtitle: 'Elimina cilindros 2D, raycast pontual e dupla autoridade entre suspensão e capotagem.',
    rationale:
      'JoltPhysics.js (MIT, WASM a 120 Hz fixos) assume corpo rígido CCD 6-DOF, juntas e colisões 3D complexas enquanto a terramecânica Bekker/SCM continua sendo a fonte autoritativa das forças de solo sem GPU readback.',
    phaseBadge: 'Núcleo WASM 120 Hz',
    subSections: [
      {
        id: 'f2-1',
        code: '2.1',
        title: 'Migração para JoltPhysics.js + Shape-Cast & MixedContactResolver',
        items: [
          {
            id: 'f2-1-1',
            title: 'Arquitetura PhysicsWorldJolt.ts + three-mesh-bvh',
            tag: '120 Hz PC / 60 Hz Leve',
            details: [
              'Novo núcleo rodando a 120 Hz fixos no PC (~8,33 ms por substep; 60 Hz no perfil Leve), com three-mesh-bvh complementar para consultas geométricas/hulls.',
            ],
          },
          {
            id: 'f2-1-2',
            title: 'Rodas Shape-Cast + Arco Multiponto + MixedContactResolver',
            tag: 'Contato Misto',
            details: [
              'Executa CastShape com CylinderShape contra malhas estáticas/dinâmicas de rochas (MeshShape/ConvexHullShape) obtendo o ponto exato na quina e a normal 3D.',
              'Em paralelo, amostra 5–7 pontos em arco na banda de rodagem (-35° a +35° + regiões laterais) contra o TerrainContactProxy CPU.',
              'Correção crítica (MixedContactResolver): resolve patches ativos simultâneos (pneu apoiado metade na pedra, metade na areia) distribuindo a carga normal total F_z sem duplicar forças.',
            ],
          },
          {
            id: 'f2-1-3',
            title: 'Higiene WASM (Zero GC & Zero Heap Leak)',
            tag: 'Memória WASM',
            details: [
              'Pool pré-alocado de Jolt.Vec3 / Jolt.Quat no boot e Jolt.destroy() explícito apenas na remoção de objetos.',
            ],
          },
        ],
      },
      {
        id: 'f2-2',
        code: '2.2',
        title: 'Trem de Força 4×4 Real (DrivetrainSolver)',
        summary: 'Inspirado em ChShaftsDrivetrain com conversor de torque/embreagem e integração direta via Wheel.SetTorque().',
        items: [
          {
            id: 'f2-2-1',
            title: 'Diferencial Aberto',
            tag: '50 / 50',
            details: ['Divide torque 50/50 com ω_eixo = (ω_E + ω_D) / 2 — se uma roda fica no ar numa pedra, ela gira livre e o carro trava.'],
          },
          {
            id: 'f2-2-2',
            title: 'LSD (Torsen / Viscoso)',
            tag: 'Limitado',
            details: ['Torque resistente proporcional a Δω: τ_lock = clamp(k_visc · (ω_E - ω_D), -τ_max, τ_max).'],
          },
          {
            id: 'f2-2-3',
            title: 'Bloqueios Dianteiro e Traseiro (Lockers)',
            tag: 'Driveline Wind-Up',
            details: [
              'Impõem ω_E = ω_D com clamping viscoso próximo a Δω ≈ 0 (evitando oscilação numérica) e geram driveline wind-up realista (aumento do raio de giro e resistência ao esterçar em piso firme).',
            ],
          },
        ],
      },
      {
        id: 'f2-3',
        code: '2.3',
        title: 'High-Centering & Undercarriage Drag',
        items: [
          {
            id: 'f2-3-1',
            title: 'Amostragem inferior de chassi, cárter e diferenciais',
            tag: 'Mecânica Assinatura',
            details: [
              'Amostra diferencial dianteiro, cárter, caixa de transferência, longarinas e diferencial traseiro contra o TerrainContactProxy e CastRay curto para rochas.',
              'Quando os sulcos ficam mais fundos que o vão livre, a barriga recebe sustentação vertical no Jolt que rouba carga normal (F_z) das 4 rodas, reduz tração, aplica resistência passiva de bulldozing e registra pincel no BrushEncoder para o diferencial “arar” a crista central.',
            ],
          },
        ],
      },
      {
        id: 'f2-4',
        code: '2.4',
        title: 'Risco Real de PSI Extremo (Rim-Strike, Rigidez & Debeading)',
        items: [
          {
            id: 'f2-4-1',
            title: 'Trade-off autêntico entre 10 e 36 PSI',
            tag: '10–36 PSI',
            details: [
              'Baixar para 10–12 PSI amplia a área de contato (~180%) e reduz o afundamento, mas diminui a rigidez lateral C_α (direção mais mole, maior slip angle).',
              'Reduz a folga até o aro: batida seca de aro (rim-strike) com impulso rígido, faíscas e som metálico em quinas de pedra.',
              'Acumula risco de destalonamento (debeading) se PSI < 14 sob alta força lateral (cai para 0 PSI e perde 90% da rigidez lateral até reparar).',
            ],
          },
        ],
      },
      {
        id: 'f2-5',
        code: '2.5',
        title: 'Solid Axle (Eixo Rígido) & Torção de Longarina (Chassis Flex)',
        items: [
          {
            id: 'f2-5-1',
            title: 'Eixo Rígido com HingeConstraint / Trailing Arms',
            tag: 'Articulação',
            details: ['Conecta fisicamente as duas rodas de um eixo a um corpo/braço articulado, induzindo câmber oposto realista e mantendo o vão livre do diferencial coerente em cruzamento de eixos.'],
          },
          {
            id: 'f2-5-2',
            title: 'Torção de Longarina (±8° Roll)',
            tag: 'PC / Híbrido',
            details: [
              'Divide o caminhão em 2 corpos rígidos no Jolt (Dianteiro/Cabine + Traseiro/Caçamba) unidos por SixDOFConstraint permitindo apenas torção longitudinal controlada (±8° em roll, mola + amortecedor) — fundido em corpo único no perfil Leve mobile.',
              'Conceito inspirado em Rigs of Rods, implementado do zero sobre Jolt sem código GPL.',
            ],
          },
        ],
      },
      {
        id: 'f2-6',
        code: '2.6',
        title: 'Dano Plástico por Energia (Joules) & Pedras Enterradas Dinâmicas',
        items: [
          {
            id: 'f2-6-1',
            title: 'Chassi CompoundShape + Deformação em Joules',
            tag: 'OnContactAdded',
            details: [
              'Calcula E = ½ · m_efetivo · v_rel², diferenciando impactos rígidos de resistência granular prolongada e deformando permanentemente o Vertex Buffer da lataria no ponto/vetor do impulso.',
            ],
          },
          {
            id: 'f2-6-2',
            title: 'Pedras Parcialmente Enterradas',
            tag: 'Erosão Dinâmica',
            details: ['Pedras inicialmente sustentadas pela areia perdem apoio conforme a erosão/escavação remove o sedimento ao redor e passam a rolar dinamicamente no Jolt.'],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-3',
    indexLabel: '04',
    navTitle: 'Fase 3 — Geomecânica',
    title: 'Fase 3 — Geomecânica Conservativa, Massa & Evolução da Paisagem',
    subtitle: 'Eleva a areia de “heightmap que afunda” para um meio granular com conservação de massa e memória histórica.',
    rationale:
      'Garante execução CPU/GPU determinística e verificável com sincronização estrita entre colisão e malha visual.',
    phaseBadge: 'Conservação de Massa',
    subSections: [
      {
        id: 'f3-1',
        code: '3.1',
        title: 'TerrainMaterialState, Substrato Rígido & SedimentMassLedger (Fundação P0)',
        items: [
          {
            id: 'f3-1-1',
            title: 'Estado independente do shader sobre substrato rígido',
            tag: 'Fundação P0',
            details: [
              'Cada célula/região guarda espessura de areia solta sobre substrato rígido (terra compactada ou rocha — impede escavar infinitamente), densidade aparente ρ_b, compactação, umidade, resistência ao cisalhamento e histórico de passagens.',
            ],
          },
          {
            id: 'f3-1-2',
            title: 'Conservação explícita de massa & TerrainStateSync',
            tag: 'Mᵢ = ρ_b,i · Aᵢ · hᵢ',
            details: [
              'Atualiza Mᵢ(t+1) = Mᵢ(t) + ∑ M_entrada - ∑ M_saída + M_fonte, separando compactação (altura cai porque ρ_b subiu, sem perda de massa) de remoção/transporte.',
              'Toda deformação gera operação única atualizando TerrainContactProxy (CPU) e BrushEncoder (GPU), garantindo que avalanches e relaxamentos não deixem colisão dessincronizada; coordenadas mundiais estáveis independentes do wrap toroidal.',
            ],
          },
        ],
      },
      {
        id: 'f3-2',
        code: '3.2',
        title: 'Slip-Sinkage, Histerese Elasto-Plástica (Chrono SCM), Dilatância & Rut-Wall Trapping',
        items: [
          {
            id: 'f3-2-1',
            title: 'Slip-Sinkage (Lyasko 2010 / Ding et al.)',
            tag: 'Escavação por Patinagem',
            details: [
              'Patinar forte (slipRatio > 0.4) escava 2–3× mais fundo: z_total = z₀ · (1 + k_s · |s|^1,3), punindo excesso de acelerador em 36 PSI e recompensando 12 PSI + 4L (~18% menos afundamento e ~34% menos arrasto de compactação).',
              'Regularização em baixa velocidade: s = (ωr - v) / max(|ωr|, |v|, 0,3).',
            ],
          },
          {
            id: 'f3-2-2',
            title: 'Descarregamento Elástico (Project Chrono SCM)',
            tag: 'Zero Tremor',
            details: ['σ_try = k_e · (z - z_p) sobre profundidade plástica z_p, eliminando tremores ao parar/balançar no sulco.'],
          },
          {
            id: 'f3-2-3',
            title: 'Resposta Longitudinal/Lateral Separadas & Rut-Wall Trapping',
            tag: 'Briga no Volante',
            details: [
              'Curvas distintas para slipRatio, slipAngle e cisalhamento; resistência ao rolamento dependente da cunha frontal.',
              'Paredes de sulcos profundos puxam lateralmente o pneu e exigem ângulo/torque para escapar; ombro do pneu empurra montes contra as paredes.',
            ],
          },
          {
            id: 'f3-2-4',
            title: 'Compactação Progressiva & Dilatância',
            tag: 'Memória Histórica',
            details: ['Primeira passagem deforma muito mais que passagens repetidas no mesmo trilho; suporte a contração (areia solta) vs. expansão (areia densa) sob cisalhamento.'],
          },
        ],
      },
      {
        id: 'f3-3',
        code: '3.3',
        title: 'Onda de Proa Assimétrica (Bow-Wave), Avalanches Conservativas & Perfil V vs. U',
        items: [
          {
            id: 'f3-3-1',
            title: 'Onda de Proa & Montes de Atolamento',
            tag: '4 Pincéis',
            details: ['4 pincéis assimétricos deslocados por slipAngle β empilham areia à frente da roda — em atolamentos, o monte formado oferece resistência mecânica real contra tentativas posteriores de avanço.'],
          },
          {
            id: 'f3-3-2',
            title: 'Avalanche com Fluxo Conservativo + Histerese',
            tag: 'Ângulo Estático vs. Dinâmico',
            details: ['Transfere massa calculada entre células (em vez de suavizar cegamente) com ângulo de repouso estático vs. dinâmico distintos e variáveis por tipo de solo.'],
          },
          {
            id: 'f3-3-3',
            title: 'Biomas V vs. U & Cravos Procedurais (microImprint)',
            tag: 'MudRunner Style',
            details: ['Perfil V na areia seca vs. U na lama coesiva + mud offset; canal microImprint gera normal + micro-AO procedural alinhada ao rolamento sem aliasing (borrando quando slipRatio > 0.35).'],
          },
        ],
      },
      {
        id: 'f3-4',
        code: '3.4',
        title: 'Zonas Heterogêneas (CPU = GPU), Erosão Eólica & Singing Sand',
        items: [
          {
            id: 'f3-4-1',
            title: 'Zonas Heterogêneas Determinísticas (grade 64×64 ou hash inteiro)',
            tag: '4 Tipos de Solo',
            details: [
              'Areia de Duna padrão.',
              'Fesh-Fesh: baixo k_φ, alto k_s, poeira 2,5×.',
              'Crosta Salina Quebradiça: rompe em p > p_yield com estalo.',
              'Areia Úmida de Baixada.',
            ],
          },
          {
            id: 'f3-4-2',
            title: 'Transporte Eólico & Deposição em Rochas (Inria 2024 / Oasis)',
            tag: 'Erosão & Deposição',
            details: [
              'Separa saltation, suspensão e deslocamento superficial; modela sombra aerodinâmica das rochas para erodir barlavento e depositar sedimento a sotavento com recuperação superficial lenta (sem apagar compactação profunda).',
            ],
          },
          {
            id: 'f3-4-3',
            title: 'Avalanches em Encostas & Singing Sand',
            tag: 'Encostas > 30°',
            details: ['Detecção CPU em encostas > 30° sob cisalhamento acionando fluxo conservativo, partículas descendo o gradiente e ressonador 70–105 Hz (+ harmônico 2×).'],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-4',
    indexLabel: '05',
    navTitle: 'Fase 4 — Luz & Poeira',
    title: 'Fase 4 — Iluminação PC Ultra, Atmosfera Física & Poeira Volumétrica',
    subtitle: 'Padrão Forza Horizon 5 / Uncharted 4 no PC Ultra com degradação limpa no Híbrido e Mobile.',
    rationale:
      'Sincroniza sombras de longa distância com o deslocamento toroidal, substitui o céu estático por atmosfera fisicamente calibrada e traz vorticidade real à poeira.',
    phaseBadge: 'Dual-Tier Visual',
    subSections: [
      {
        id: 'f4-1',
        code: '4.1',
        title: 'Cascaded Shadow Maps (CSM) Integrados ao Clipmap',
        items: [
          {
            id: 'f4-1-1',
            title: 'PC Ultra: 4 Cascatas (2048²) com Texel Snapping',
            tag: '0–600 m+',
            details: [
              '0–8 m: cravos/molas/para-choque ultra-nítidos.',
              '8–30 m: pedras próximas.',
              '30–120 m: morros/rochas.',
              '120–600 m+: dunas distantes.',
              'Híbrido: 2 cascatas 1024² · Leve: 1 shadow map direcional.',
            ],
          },
          {
            id: 'f4-1-2',
            title: 'Sincronia Obrigatória de Vertex Displacement',
            tag: 'customDepthMaterial',
            details: ['Injetar exatamente o mesmo vertex displacement toroidal no customDepthMaterial do CSM com bias dinâmico por cascata para eliminar descolamento de sombra em dunas íngremes.'],
          },
        ],
      },
      {
        id: 'f4-2',
        code: '4.2',
        title: 'Atmosfera Física, Sombras de Nuvens & Rebote Quente da Areia',
        items: [
          {
            id: 'f4-2-1',
            title: 'Atmosfera Física (@takram/three-atmosphere) vs. Mip Fog',
            tag: 'HDR Calibrado',
            details: [
              'Ultra PC usa @takram/three-atmosphere (Bruneton/Hillaire com LUTs de transmitância/espalhamento e calibração HDR estrita antes do Bloom/AgX para evitar estouro RGBA16F).',
              'Híbrido / Leve usa Mip Fog (Uncharted 4) amostrando o PMREM do AtmosphericIBL + fase Mie (1 fetch).',
            ],
          },
          {
            id: 'f4-2-2',
            title: 'Sombras de Nuvens Globais (< 0,2 ms)',
            tag: '2D FBM XZ',
            details: ['Textura 2D FBM em evolução lenta projetada no plano mundial XZ modulando irradiância solar direta no terreno, rochas e veículo — sem pagar 8–12 ms de raymarching 3D.'],
          },
          {
            id: 'f4-2-3',
            title: 'Rebote Indireto Quente (GI Leve)',
            tag: 'Multi-Bounce',
            details: [
              'Termo hemisférico dot(N, vec3(0, -1, 0)) modulado pela cor do bioma + Bent Normals do GTAO iluminando a barriga do caminhão e caixas de roda, somado a multi-bounce quente nas slip-faces das dunas (preservando oclusão para não somar luz fictícia).',
            ],
          },
        ],
      },
      {
        id: 'f4-3',
        code: '4.3',
        title: 'Poeira 6-Way Lightmap, Soft Depth-Fade, Sombra no Solo & Esteira Dual-Tier',
        items: [
          {
            id: 'f4-3-1',
            title: '6-Way Lightmap (RTB + LBF) + Soft Depth-Fade Sem Feedback Loop',
            tag: 'Recorte Octogonal',
            details: ['Opacos em rtOpaque + poeira em rtDust (resolução nativa no Ultra PC, meia resolução no Híbrido) lendo rtOpaque.depthTexture manualmente, com polígonos octogonais recortados.'],
          },
          {
            id: 'f4-3-2',
            title: 'Sombra Projetada da Poeira (Beer/Transmittance)',
            tag: '0 Samplers Terreno',
            details: ['Splatting aditivo R8/RGBA8 (sem depender de EXT_float_blend), 256² a 60 Hz no Ultra PC (384+ partículas) e 128² a 30 Hz no Híbrido (~192 partículas), aplicada no PostProcessingPipeline.'],
          },
          {
            id: 'f4-3-3',
            title: 'Esteira Aerodinâmica Dual-Tier & Faróis Volumétricos',
            tag: 'Navier-Stokes 2D PC',
            details: [
              'Ultra PC roda solver toroidal Navier-Stokes 2D real em GPU (128²–256²); Híbrido / Leve usa campo analítico (dipolo + vórtices de von Kármán + 2D Curl Noise, zero FBOs extras).',
              '2 cones geométricos Fresnel-faded + depth-fade nos faróis e máscara analítica de acúmulo de poeira na traseira/arcos de roda (Wake Dust Clinging, lavável na água).',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-5',
    indexLabel: '06',
    navTitle: 'Fase 5 — Cinestesia & Som',
    title: 'Fase 5 — Cinestesia de Peso, Áudio Waveguide + PhISEM & Periféricos PC',
    subtitle: 'Conecta a física hardcore de 120 Hz diretamente aos sentidos do piloto: câmera inercial, som físico sem samples e Force Feedback.',
    phaseBadge: 'Sensação de 2 Toneladas',
    rationale: 'Física impecável perde metade do impacto se a câmera for rígida, o som vier de loops estáticos e o controle não comunicar perda de tração.',
    subSections: [
      {
        id: 'f5-1',
        code: '5.1',
        title: 'Câmera Física 2ª Ordem + Horizon Roll-Blend + Driveline Twist & Wheel-Hop',
        items: [
          {
            id: 'f5-1-1',
            title: 'Câmera Inercial (BeamNG v0.38)',
            tag: 'Massa-Mola 2ª Ordem',
            details: [
              'Equação: d̈_c = ω_n² · (d_alvo - d_c) - 2·ζ·ω_n·ḋ_c em passo fixo.',
              'Horizonte 70–80% estabilizado em costelas (caindo para 0% acima de 55° em capotagens), micro-impulso nos bump-stops e FOV pump contido (≤ 5°).',
            ],
          },
          {
            id: 'f5-1-2',
            title: 'Dinâmica Secundária (Driveline, Wheel-Hop & Pêndulos)',
            tag: 'Ligado ao Sidewall Bulge',
            details: [
              'Torque reativo do cardã em 4L (τ_roll = c_drive · τ_cardã).',
              'Wheel-hop pneumático (12,5 Hz @ 36 PSI vs. 7,9 Hz @ 10 PSI) ligado ao Sidewall Bulge e pêndulos leves amortecidos (antena, para-barros, carga).',
            ],
          },
        ],
      },
      {
        id: 'f5-2',
        code: '5.2',
        title: 'Áudio Mecânico por Waveguide (Engine_Sim) + Granular PhISEM em AudioWorklet',
        items: [
          {
            id: 'f5-2-1',
            title: 'Motor & Transmissão por Waveguide (engine-synth.worklet.ts)',
            tag: 'Zero .wav / Engine_Sim',
            details: [
              'Roda em thread dedicada de áudio recebendo telemetria a 120 Hz via SharedArrayBuffer ou MessagePort leve.',
              'Pulsos discretos de combustão por cilindro conforme o ângulo do virabrequim (θ); 2 a 4 delay lines passa-baixa (1 linha no Leve) simulando coletor e escapamento.',
              'Turbo spool + blow-off, chiado de engrenagem reta na reduzida 4L e gear-lash clunk nos diferenciais bloqueados.',
            ],
          },
          {
            id: 'f5-2-2',
            title: 'Granular PhISEM (Perry Cook) acoplado & Build Vite Seguro',
            tag: '4 Canais 3D',
            details: [
              '4 canais com panorâmica 3D por roda no PC / Híbrido (2 por eixo no Leve) sintetizando cisalhamento de areia seca (2,1 / 4,2 kHz), Singing Sand (85–95 Hz), sucção de lama (350 Hz → 1,4 kHz), estalo de crosta salina e raspar metálico de high-centering.',
              'Carregar worklets via ?worker&url / new URL(..., import.meta.url) com fallback automático em BiquadFilterNode.',
            ],
          },
        ],
      },
      {
        id: 'f5-3',
        code: '5.3',
        title: 'Periféricos de Simulador PC: Gamepad Analógico & Volante (Force Feedback)',
        items: [
          {
            id: 'f5-3-1',
            title: 'Gamepad API (GamepadHaptics.ts) — Curvas & Rumble Dual-Channel',
            tag: 'Dosagem Fina',
            details: [
              'Curvas de sensibilidade para acelerador/freio/direção analógicos (fundamental para dosar tração e evitar slip-sinkage!).',
              'Canal grave (baixa frequência): wheel-hop, rim-strike em 10 PSI, engasgo em baixa rotação e batidas de suspensão.',
              'Canal agudo (alta frequência): textura de slip-sinkage, resistência de rut-wall trapping e quebra de crosta.',
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'fase-6',
    indexLabel: '07',
    navTitle: 'Fase 6 — Sandbox & WebGPU',
    title: 'Fase 6 — Sandbox Off-Road, Laboratório WebGPU/MLS-MPM & Validação',
    subtitle: 'Ferramentas de resgate, laboratório científico PC, volume granular 3D experimental e matriz de 9 testes.',
    rationale: 'Une o sandbox off-road completo (Maxtrax, guincho XPBD, reboque, chuva 2D) com a fronteira experimental de volume granular 3D WebGPU/TSL e gates quantitativos de aceitação.',
    phaseBadge: 'PC Showcase & QA',
    subSections: [
      {
        id: 'f6-1',
        code: '6.1',
        title: 'Interações Sandbox no Jolt + BrushEncoder',
        items: [
          {
            id: 'f6-1-1',
            title: 'Peças Destacadas, Pedras Soltas & Anel de Choque',
            tag: 'Crateras Dinâmicas',
            details: ['Corpos rígidos do Jolt que quicam nas rochas e consultam o terreno CPU, emitindo crateras/sulcos nos slots livres do BrushEncoder + anel radial no pico de aterrissagem F_z.'],
          },
          {
            id: 'f6-1-2',
            title: 'Pranchas Maxtrax',
            tag: 'Resgate',
            details: ['2 corpos/OBBs leves (three-mesh-bvh + Jolt) sobrescrevendo localmente k_φ e c em SandTerramechanics, arremessadas para trás se o pneu patinar bruscamente.'],
          },
          {
            id: 'f6-1-3',
            title: 'Guincho Elástico XPBD + Deadman Anchor & Reboque Articulado',
            tag: 'Cabo 1D + Reboque',
            details: [
              'Cabo visual 1D em XPBD aplicando força elástica real (Hooke + amortecimento) no Jolt e rasgando vala se arrancar a âncora.',
              'Reboque de 2 rodas conectado por PointConstraint/ConeConstraint deixando 2 sulcos extras no BrushEncoder.',
            ],
          },
          {
            id: 'f6-1-4',
            title: 'Chuva Localizada & Poças 2D (Dual-Tier)',
            tag: 'Shallow Water 2D',
            details: ['Acúmulo em depression com 4 fases ópticas; grade dedicada 128²/256² RG16F de perturbação relativa (Shallow Water 2D) no Ultra PC e anéis analíticos no Híbrido/Leve.'],
          },
        ],
      },
      {
        id: 'f6-2',
        code: '6.2',
        title: 'Modo Laboratório Científico & Ferramentas de Debug (Opcional — PC)',
        items: [
          {
            id: 'f6-2-1',
            title: 'Debug Físico Completo & Comparativos Reproduzíveis',
            tag: 'PC Lab',
            details: [
              'Visualização opcional de contatos mistos, normais, pressões, densidade, compactação, fluxos de sedimento e campos SDF.',
              'Fantasma Comparativo (36 PSI vs 12 PSI), Replays Determinísticos (seed + eventos de deformação), Lupa Diagnóstica GPU e Scanner Geotécnico Subterrâneo.',
            ],
          },
        ],
      },
      {
        id: 'f6-3',
        code: '6.3',
        title: 'Rota Experimental PC Ultra — WebGPU + TSL & Volume Granular (MLS-MPM / DEM)',
        summary: 'O motor principal permanece 100% sólido em WebGL2. O modo experimental “PC Ultra (WebGPU)” usa WebGPURenderer + TSL (Three.js r187) para rodar um volume local móvel (4 m × 4 m × 0,4 m) ao redor das rodas/obstáculos sem migrar toda a engine prematuramente.',
        items: [
          {
            id: 'f6-3-1',
            title: 'Implementação rigorosa (2D isolado → 3D Drucker-Prager)',
            tag: 'Sem Chutes de FPS',
            details: [
              'Validar primeiro um protótipo MLS-MPM 2D isolado (queda, empilhamento, cisalhamento, colapso) antes de evoluir para 3D.',
              'Modelo constitutivo Drucker–Prager (e estudo futuro de modelos hipoplásticos/estado crítico para dilatância), grade 3D ativa e esparsa, colisões por SDF com velocidades de fronteira e remapeamento de domínio móvel sem teleporte de partículas.',
            ],
          },
          {
            id: 'f6-3-2',
            title: 'Atomics em WGSL & Estabilidade do SVD',
            tag: 'WGSL Compute',
            details: [
              'Sem atomicAdd nativo em float: comparar benchmark de acumulação P2G via i32/u32 em ponto fixo (Zarathos94/mls-mpm-gpu) vs. loops compare-and-swap (harri665/MPM), testando estabilidade numérica do SVD contra NaN/Inf.',
            ],
          },
          {
            id: 'f6-3-3',
            title: 'Substep CFL próprio & Protocolo Conservativo de Massa',
            tag: 'Desacoplado do Jolt',
            details: [
              'Terreno debita massa uma única vez → emite material points MPM (65k material points são volumes de ~4,6 cm, não grãos microscópicos!) → partículas escorrem sobre/sob geometrias 3D e empilham em cavidades/caçamba → reincorporação conservativa ao estabilizar.',
              'Inicialmente sem devolver forças ao Jolt (acoplamento bidirecional é pesquisa separada).',
              'Estudo complementar: DEM localizado (Chrono DEM-Engine / veloxsim-dem-open) e LBM-MPM (DacianShaw/LBM-MPM-Air-Water-Sand) para acoplamento água–areia–ar.',
            ],
          },
        ],
        tables: [
          {
            caption: 'Perfis de Experimento & Profiling Real (GPUDevice.limits)',
            headers: ['Perfil', 'Partículas & Grade', 'Objetivo & Orçamento'],
            rows: [
              ['Validação', '4.096–16.384 partículas em 32³', 'Matemática, plasticidade e conservação de massa'],
              ['Intermediário', '32.768–65.536 partículas em 48³–64³', '~8 MiB só para grade principal'],
              ['Estresse', '131.072+ partículas em 64³–128³', 'Limites de atomics, memória e p95/p99 (meta experimental ≤ 3 ms em GPU dedicada confirmada por benchmark real)'],
            ],
          },
        ],
      },
      {
        id: 'f6-4',
        code: '6.4',
        title: 'Matriz de Validação Científica (9 Testes de Aceitação) & Gates de Desempenho',
        summary: 'Todo avanço de física/areia deve passar por benchmarks reproduzíveis (separando CPU, GPU, transferências, p95/p99 e heap WASM) e pelos 9 cenários de validação.',
        items: [
          { id: 'f6-4-1', title: '1. Pilha de areia', tag: 'Teste 01', details: ['Formar cone e medir ângulo de inclinação, relaxamento e conservação de massa final.'] },
          { id: 'f6-4-2', title: '2. Colapso de coluna', tag: 'Teste 02', details: ['Remover parede lateral e comparar geometria de espalhamento.'] },
          { id: 'f6-4-3', title: '3. Roda em areia solta', tag: 'Teste 03', details: ['Medir sinkage, resistência, torque, slip e perfil do sulco.'] },
          { id: 'f6-4-4', title: '4. Passagens repetidas', tag: 'Teste 04', details: ['Validar compactação progressiva entre 1ª e N-ésima passagem.'] },
          { id: 'f6-4-5', title: '5. Rocha parcialmente enterrada', tag: 'Teste 05', details: ['Escavar sedimento até perder apoio e validar liberação dinâmica no Jolt.'] },
          { id: 'f6-4-6', title: '6. Obstáculo com vento', tag: 'Teste 06', details: ['Validar erosão a barlavento e deposição a sotavento.'] },
          { id: 'f6-4-7', title: '7. Janela MPM móvel', tag: 'Teste 07', details: ['Deslocar domínio repetidamente sem saltos, duplicações ou perda de massa.'] },
          { id: 'f6-4-8', title: '8. Carga extrema', tag: 'Teste 08', details: ['Bursts prolongados de brushes, pedras e partículas sem queda de p99 ou leak WASM.'] },
          { id: 'f6-4-9', title: '9. Paridade CPU/GPU', tag: 'Teste 09', details: ['Comparar cenas pequenas com referência CPU determinística.'] },
        ],
      },
    ],
  },

  {
    id: 'ecossistema-sprints',
    indexLabel: '08',
    navTitle: 'Ecossistema & Sprints',
    title: 'Ecossistema Open-Source, Papers, Filtro Anti-Realismo & Sprints',
    subtitle: 'Dependências auditadas, bibliografia científica, o que evitar e a ordem exata de execução.',
    rationale: 'Centraliza decisões de licenciamento (MIT/BSD vs. GPL), referências teóricas e o plano de sprints recomendados.',
    subSections: [
      {
        id: 'eco-oss',
        code: 'OSS',
        title: 'Projetos Open-Source Auditados',
        tables: [
          {
            caption: 'Classificação de Projetos e Licenças',
            headers: ['Papel', 'Projetos & Licenças', 'Uso no DuneFlow'],
            rows: [
              [
                'Instalar (Dependências Core)',
                'jrouwe/JoltPhysics.js (MIT), gkjohnson/three-mesh-bvh (MIT), @takram/three-atmosphere (MIT), three/addons/csm/CSM.js (MIT)',
                'Física rígida 6-DOF/Shape-Cast, consultas geométricas/hulls, atmosfera física e sombras em cascata',
              ],
              [
                'Protótipo / Port / Adaptação',
                'YigitSalihEmecen/Engine_Sim (MIT), harri665/MPM (MIT), Zarathos94/mls-mpm-gpu (MIT), SamG-Coder/SandDune (MIT), weigert/SimpleWindErosion (MIT), three-fluid-fx (MIT), pmndrs/racing-game (MIT), PositionBasedDynamics / Ten Minute Physics (MIT)',
                'Áudio Waveguide em AudioWorklet, MLS-MPM 3D em WGSL (atomics/SVD), testes de conservação de massa, erosão eólica, fluido 2D e XPBD',
              ],
              [
                'Referência Científica (Não copiar GPL / C++ pesado)',
                'projectchrono/chrono & DEM-Engine (BSD-3), yuanming-hu/taichi_mpm & taichi_elements (MIT), VeloxSim/veloxsim-dem-open (MIT), Clocktown/Oasis (MIT CUDA), Inria Windblown Sand 2024, DacianShaw/LBM-MPM-Air-Water-Sand (MIT), RigsOfRods/rigs-of-rods (GPL — só conceito), larsblatny/matter (GPL — só conceito)',
                'Equações de SCM/drivetrain, contatos DEM, erosão ao redor de obstáculos, acoplamento água–areia–ar e topologia de chassi flexível',
              ],
              [
                'Descartados',
                'schteppe/cannon-es, ammo.js, dimforge/rapier3d (vs. Jolt)',
                'Jolt supera em estabilidade de rock crawling a 120 Hz, Shape-Cast nativo e VehicleConstraint',
              ],
            ],
          },
        ],
      },
      {
        id: 'eco-papers',
        code: 'Papers',
        title: 'Trilha de Papers Fundamentais',
        items: [
          { id: 'p-1', title: '1. A Moving Least Squares Material Point Method with Displacement Discontinuity and Two-Way Rigid Body Coupling', tag: 'Hu et al., 2018' },
          { id: 'p-2', title: '2. Drucker-Prager Elastoplasticity for Sand Animation', tag: 'Klár et al., 2016' },
          { id: 'p-3', title: '3. Windblown Sand Around Obstacles', tag: 'Inria, 2024' },
          { id: 'p-4', title: '4. Oasis: A Real-Time Hydraulic and Aeolian Erosion Simulation with Dynamic Vegetation', tag: '2025' },
          { id: 'p-5', title: '5. Numerical Homogenization of Sand from Grain-Level Simulations', tag: '2025' },
          { id: 'p-6', title: '6. Volume-Preserving LBM-MPM Coupling for Air-Water-Sand Mixtures', tag: 'SIGGRAPH 2026' },
          { id: 'p-7', title: '7. A Modular Hypoplastic Constitutive Model for Granular Soils', tag: '2025' },
          { id: 'p-8', title: '8. Real-Time Rendering of Glinty Appearances & Glinty Granular Materials', tag: 'Deliot & Belcour, 2022–2023' },
          { id: 'p-9', title: '9. Augmented Vertex Block Descent', tag: 'SIGGRAPH 2025' },
          { id: 'p-10', title: '10. On Hybrid Lagrangian-Eulerian Simulation Methods', tag: 'Curso SIGGRAPH 2019' },
        ],
      },
      {
        id: 'eco-filtro',
        code: 'Filtro',
        title: 'Filtro Anti-Realismo Bobo & O Que Evitar Agora',
        callout: {
          title: 'Restrições & Itens Cortados',
          items: [
            'Não substituir o terreno inteiro por partículas MLS-MPM: as cascatas toroidais + fluxo conservativo continuam ideais para dunas e sulcos extensos.',
            'Não começar por DEM com milhões de grãos nem migrar toda a engine para WebGPU agora: WebGPU/MPM entra como módulo experimental isolado de PC Ultra sem quebrar o núcleo WebGL2 estável.',
            'Não confundir fluido visual com areia: areia exige atrito interno, plasticidade (Drucker–Prager) e conservação de volume; não usar tixotropia em areia seca (substituída por slip-sinkage).',
            'Não presumir benchmarks sem medir: nunca prometer ms fixos em WebGPU/WASM sem profiling real por fase e percentis p95/p99.',
            'Itens cosméticos cortados: fulguritos decorativos, heat haze fullscreen embaçando nitidez, respingos permanentes na lente (lens droplets) e Time-Lapse Eólico gimmick.',
          ],
        },
      },
      {
        id: 'eco-sprints',
        code: 'Sprints',
        title: 'Sprints Recomendados de Execução (PC-First)',
        items: [
          {
            id: 'sp-0',
            title: 'Sprint 0 — “Hardening, 120 Hz & Performance Base” (fazer primeiro)',
            tag: 'Prioridade Máxima',
            details: ['0.1 (Build 404, Guard Band, Seam, Leaks) + 0.2 (Fixes de física atuais) + 0.3 (Draw Calls caminhão, Smoke Vertex Y, Terreno & Grama, Zero GC, Passo Fixo THREE.Timer, Uber-Composite) + 0.4 (Sync Clima/UI & Telemetria Real).'],
          },
          {
            id: 'sp-1',
            title: 'Sprint 1 — “Borracha Viva & Óptica de Contato”',
            tag: 'Fase 1',
            details: ['1.1 (Soft-Tire WPO / Sidewall Bulge + Tire Caking) + 1.2 (Porosidade 4 Fases + AO Analítica + Micro-Shadowing + SSS Crista + Sand Drift em Rochas + Glints 4K) + 1.3 (Physics Monitor Canvas + Poeira por Dissipação).'],
          },
          {
            id: 'sp-2',
            title: 'Sprint 2 — “Núcleo JoltPhysics.js (WASM) & Off-Road Hardcore”',
            tag: 'Fase 2',
            details: ['2.1 (Jolt 120 Hz + Shape-Cast + MixedContactResolver) + 2.2 (Diferenciais & Lockers) + 2.3 (High-Centering & Aragem) + 2.4 (Risco 10 PSI / Rim-Strike / Debeading) + 2.5 (Solid Axle & Ladder-Frame Flex) + 2.6 (Dano em Joules & Pedras Enterradas).'],
          },
          {
            id: 'sp-3',
            title: 'Sprint 3 — “Areia Conservativa & Paisagem Viva”',
            tag: 'Fase 3',
            details: ['3.1 (TerrainMaterialState, Substrato Rígido & SedimentMassLedger) + 3.2 (Slip-Sinkage, Chrono SCM, Dilatância & Rut-Wall Trapping) + 3.3 (Bow-Wave, Avalanches Conservativas & V vs. U) + 3.4 (Zonas Heterogêneas, Erosão em Rochas Inria 2024 & Singing Sand).'],
          },
          {
            id: 'sp-4',
            title: 'Sprint 4 — “Iluminação PC Ultra & Atmosfera Volumétrica”',
            tag: 'Fase 4',
            details: ['4.1 (CSM 4 Cascatas + Clipmap Depth) + 4.2 (@takram/three-atmosphere + Sombras de Nuvens + Rebote Quente) + 4.3 (Poeira 6-Way + Soft Depth-Fade + Sombra 128²/256² + Navier-Stokes 2D PC / Analítica Híbrido).'],
          },
          {
            id: 'sp-5',
            title: 'Sprint 5 — “Cinestesia, Áudio Waveguide + PhISEM & Controles PC”',
            tag: 'Fase 5',
            details: ['5.1 (Câmera 2ª Ordem + Horizon Roll-Blend + Driveline/Wheel-Hop) + 5.2 (Motor Waveguide Engine_Sim + PhISEM em AudioWorklet) + 5.3 (Gamepad Analógico & Force Feedback Dual-Channel).'],
          },
          {
            id: 'sp-6',
            title: 'Sprint 6 — “Sandbox, Laboratório WebGPU/MLS-MPM & Validação”',
            tag: 'Fase 6',
            details: ['6.1 (Maxtrax, Guincho XPBD, Reboque, Chuva 2D) + 6.2 (Debug Físico, Replays & Lab PC) + 6.3 (Protótipo WebGPU/TSL MLS-MPM 2D→3D + DEM) + 6.4 (Matriz de 9 Testes & Profiling p95/p99).'],
          },
        ],
      },
    ],
  },
];
