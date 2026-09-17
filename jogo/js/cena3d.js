/* cena3d.js — o canteiro em three.js.
   Carrega o .glb, liga/desliga as variantes do roteiro, move a câmera
   (andando de verdade entre as cenas) e roda as animações em tempo real. */
(function (raiz) {
  'use strict';

  var C = { pronto: false, porNome: {}, camsRoteiro: {}, camAtual: null, atores: {} };

  var renderer, cena, camera, relogio;
  var MU = THREE.MathUtils || THREE.Math;

  var alvo = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 };
  var origem = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 };
  var modo = 'parado';                 // parado | trilho | caminhada | seguir
  var viagem = { t: 1, dur: 1, aoFim: null, relogio: null };
  var passeio = null;
  var perseguir = null;
  var olhar = { yaw: 0, pitch: 0, arrastando: false, x: 0, y: 0, ativo: false };
  var LIM_YAW = MU.degToRad(46), LIM_PITCH = MU.degToRad(28);
  var quedas = [], cordas = [];
  var ALTURA_OLHOS = 1.62;

  /* ------------------------------------------------------------- arranque */
  C.iniciar = function (el) {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);

    cena = new THREE.Scene();
    cena.background = new THREE.Color(0xbcd8ff);
    cena.fog = new THREE.Fog(0xc8ddf5, 240, 900);

    camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.05, 2000);
    cena.add(camera);

    var sol = new THREE.DirectionalLight(0xfff4e6, 2.2);
    sol.position.set(41, 72, 56);
    sol.castShadow = true;
    sol.shadow.mapSize.set(1024, 1024);
    var s = sol.shadow.camera;
    s.left = -70; s.right = 70; s.top = 70; s.bottom = -70; s.near = 1; s.far = 320;
    sol.shadow.bias = -0.0006;
    cena.add(sol, sol.target);
    cena.add(new THREE.HemisphereLight(0xbcd8ff, 0xd9b48a, 1.1));

    relogio = new THREE.Clock();
    window.addEventListener('resize', function () {
      var w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ligarOlhar(renderer.domElement);
    animar();
  };

  /* ----------------------------------------------------------------- carga */
  C.carregar = function (url, pastaDraco, aoProgresso) {
    return new Promise(function (ok, erro) {
      var draco = new THREE.DRACOLoader();
      draco.setDecoderPath(pastaDraco);
      draco.setDecoderConfig({ type: 'js' });
      var loader = new THREE.GLTFLoader();
      loader.setDRACOLoader(draco);
      loader.load(url, function (gltf) {
        var r = gltf.scene;
        r.traverse(function (o) {
          if (o.name) C.porNome[o.name] = o;
          if (o.isMesh) {
            o.castShadow = true; o.receiveShadow = true;
            if (o.material && o.material.map) {
              o.material.map.anisotropy = 4;
              o.material.map.magFilter = THREE.NearestFilter;
              o.material.map.minFilter = THREE.LinearMipmapLinearFilter;
            }
          }
          if (o.isCamera && /^CAM_(1P|3P)_/.test(o.name)) {
            o.updateWorldMatrix(true, false);
            var p = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Vector3();
            o.matrixWorld.decompose(p, q, e);
            C.camsRoteiro[o.name] = { pos: p, quat: q, fov: o.fov || 50 };
          }
        });
        cena.add(r);
        C.raiz = r;
        montarAtores();
        C.estadoInicial();
        C.pronto = true;
        ok(C);
      }, function (ev) {
        if (aoProgresso && ev.total) aoProgresso(ev.loaded / ev.total);
      }, erro);
    });
  };

  function montarAtores() {
    Object.keys(C.porNome).forEach(function (n) {
      var o = C.porNome[n];
      if (!o.userData || !o.userData.articulado) return;
      var a = raiz.Anim && raiz.Anim.ator(n, o);
      if (!a) return;
      C.atores[n] = a;
      var u = o.userData;
      var clip = (raiz.Anim.CLIP_DA_POSE || {})[u.pose] || 'parado';
      a.tocar(u.tarefa_fixa || clip);
      a.paradaInicial = u.tarefa_fixa || clip;
      // carga presa ao tronco (caixa na frente, tábua no ombro): braços parados
      a.bracosPresos = (u.pose === 'carregando_frente' || u.pose === 'carregando_ombro');
      if (u.patrulha && u.patrulha.length >= 4) {
        // Blender (x, y) -> Three (x, -y); o andar mantém a altura do piso
        var pts = [];
        for (var i = 0; i + 1 < u.patrulha.length; i += 2) pts.push(u.patrulha[i], -u.patrulha[i + 1]);
        a.rotina(pts, u.atividades, { vel: u.vel_andar || 0.85, espera: u.espera || 12,
                                      esperas: u.esperas });
        a.ehFigurante = true;
      }
      if (u.conectado_em) criarCorda(a, u.conectado_em);
    });
  }

  C.ator = function (nome) { return C.atores[nome] || null; };

  C.estadoInicial = function () {
    Object.keys(C.porNome).forEach(function (n) {
      var o = C.porNome[n];
      if (o.userData && typeof o.userData.visivel_inicial !== 'undefined') {
        o.visible = !!o.userData.visivel_inicial;
      }
    });
    quedas.length = 0;
    C.pararMovimentos();
    Object.keys(C.atores).forEach(function (n) {
      var a = C.atores[n];
      a.reiniciar();
      if (!a.ehFigurante) a.tocar(C.porNome[n].userData.tarefa_fixa ||
        (raiz.Anim.CLIP_DA_POSE || {})[C.porNome[n].userData.pose] || 'parado');
    });
  };

  /** Duas pessoas nunca no mesmo lugar: ao entrar em cena, quem estava ali sai.
      Cada evento do roteiro tem o seu elenco no mesmo ponto da laje, e um evento
      não apaga o anterior - sem isto, dois bonecos ficam um dentro do outro. */
  var LUGAR_OCUPADO = 0.55;
  function abrirEspaco(nome) {
    var novo = C.porNome[nome];
    if (!novo) return;
    Object.keys(C.atores).forEach(function (n) {
      if (n === nome) return;
      var o = C.porNome[n];
      if (!o || !o.visible) return;
      if (Math.abs(o.position.y - novo.position.y) > 1.2) return;
      var dx = o.position.x - novo.position.x, dz = o.position.z - novo.position.z;
      if (dx * dx + dz * dz < LUGAR_OCUPADO * LUGAR_OCUPADO) o.visible = false;
    });
  }

  C.mostrar = function (lista) {
    (lista || []).forEach(function (n) {
      var o = C.porNome[n];
      if (!o) return;
      if (n.indexOf('AVATAR_') === 0) C.soUmAvatar(n);
      if (C.atores[n]) abrirEspaco(n);
      o.visible = true;
      var a = C.atores[n];
      if (a && !a.ehFigurante) {                 // reinicia a animação de quem acabou de entrar em cena
        a.reiniciar();
        a.clip = null;
        a.tocar(o.userData.tarefa_fixa || (raiz.Anim.CLIP_DA_POSE || {})[o.userData.pose] || 'parado');
      }
    });
  };
  C.ocultar = function (lista) {
    (lista || []).forEach(function (n) { var o = C.porNome[n]; if (o) o.visible = false; });
  };
  /** o jogador tem um corpo só: mostrar um avatar esconde todos os outros. */
  C.soUmAvatar = function (menos) {
    Object.keys(C.porNome).forEach(function (n) {
      if (n.indexOf('AVATAR_') === 0 && n !== menos) C.porNome[n].visible = false;
    });
  };
  C.semAvatar = function () { C.soUmAvatar(null); };
  C.aplicar = function (passo) { if (!passo) return; C.ocultar(passo.ocultar); C.mostrar(passo.mostrar); };

  /* ---------------------------------------------------------------- câmera */
  function definirAlvo(nome) {
    var c = C.camsRoteiro[nome];
    if (!c) { console.warn('câmera ausente no .glb:', nome); return false; }
    alvo.pos.copy(c.pos); alvo.quat.copy(c.quat); alvo.fov = c.fov;
    C.camAtual = nome;
    return true;
  }

  C.posicaoDe = function (nome) {
    var c = C.camsRoteiro[nome];
    return c ? c.pos.clone() : null;
  };

  /** corta ou viaja suave até uma câmera do roteiro. */
  C.irPara = function (nome, opc) {
    opc = opc || {};
    if (!definirAlvo(nome)) return Promise.resolve();
    olhar.yaw = 0; olhar.pitch = 0;
    passeio = null; perseguir = null;
    if (opc.trilho === false) {
      concluir();
      camera.position.copy(alvo.pos); camera.quaternion.copy(alvo.quat);
      camera.fov = alvo.fov; camera.updateProjectionMatrix();
      modo = 'parado';
      return Promise.resolve();
    }
    origem.pos.copy(camera.position); origem.quat.copy(camera.quaternion); origem.fov = camera.fov;
    var d = origem.pos.distanceTo(alvo.pos);
    viagem.dur = opc.dur || Math.min(2.4, Math.max(0.7, 0.4 + d * 0.05));
    viagem.t = 0;
    modo = 'trilho';
    return new Promise(function (ok) {
      concluir();
      viagem.aoFim = ok;
      viagem.relogio = setTimeout(concluir, viagem.dur * 1000 + 600);
    });
  };

  /** vai andando até a próxima câmera, em tempo real. Só usa quando dá pé. */
  C.caminharAte = function (nome, opc) {
    opc = opc || {};
    var c = C.camsRoteiro[nome];
    if (!c) return Promise.resolve();
    var de = camera.position.clone();
    var dist = Math.sqrt(Math.pow(c.pos.x - de.x, 2) + Math.pow(c.pos.z - de.z, 2));
    var desnivel = Math.abs(c.pos.y - de.y);
    if (dist < 0.5 || dist > (opc.maxDist || 26) || desnivel > (opc.maxDesnivel || 0.9)) {
      return C.irPara(nome, { trilho: true, dur: opc.dur });
    }
    definirAlvo(nome);
    olhar.yaw = 0; olhar.pitch = 0;
    perseguir = null;
    var pontos = (opc.pontos || []).map(function (p) { return new THREE.Vector3(p.x, p.y, p.z); });
    pontos.push(c.pos.clone());
    qAndando.copy(camera.quaternion);
    passeio = {
      pontos: pontos, i: 0, vel: opc.vel || 1.45, fase: 0,
      quatFinal: c.quat.clone(), dist: dist, aoFim: null
    };
    modo = 'caminhada';
    return new Promise(function (ok) {
      passeio.aoFim = ok;
      passeio.relogio = setTimeout(function () { fimPasseio(); }, (dist / (opc.vel || 1.45)) * 1000 + 4000);
    });
  };

  function fimPasseio() {
    if (!passeio) return;
    if (passeio.relogio) clearTimeout(passeio.relogio);
    var f = passeio.aoFim;
    passeio = null;
    modo = 'parado';
    camera.position.copy(alvo.pos);
    camera.quaternion.copy(alvo.quat);
    camera.fov = alvo.fov;
    camera.updateProjectionMatrix();
    if (f) f();
  }

  /** centro visível de um objeto — muitos têm a origem em (0,0,0) com a malha
      desenhada em coordenadas do mundo, então a origem não serve para mirar. */
  var _bb = new THREE.Box3();
  C.centroDe = function (o) {
    _bb.setFromObject(o);
    return _bb.getCenter(new THREE.Vector3());
  };

  /** a câmera acompanha um objeto (usado quando algo cai ou escorrega). */
  C.seguir = function (obj, opc) {
    opc = opc || {};
    if (!obj) return;
    var centro = C.centroDe(obj);
    perseguir = {
      obj: obj, suav: opc.suav || 4.0,
      desvio: centro.sub(obj.position)      // do referencial do objeto até o que se vê
    };
    modo = 'seguir';
  };
  C.pararSeguir = function () { if (modo === 'seguir') { perseguir = null; modo = 'parado'; } };

  /** acompanha o tronco de um personagem (para quedas e desequilíbrios). */
  C.seguirAtor = function (a, opc) {
    if (!a) return;
    var alvoPeca = a.pecas.Torso || a.raiz;
    perseguir = { obj: alvoPeca, suav: (opc && opc.suav) || 4.5, desvio: new THREE.Vector3(0, 0.2, 0), mundo: true };
    modo = 'seguir';
  };

  function concluir() {
    if (viagem.relogio) { clearTimeout(viagem.relogio); viagem.relogio = null; }
    if (!viagem.aoFim) return;
    var f = viagem.aoFim;
    viagem.aoFim = null;
    viagem.t = 1;
    camera.position.copy(alvo.pos);
    camera.quaternion.copy(alvo.quat);
    camera.fov = alvo.fov;
    camera.updateProjectionMatrix();
    modo = 'parado';
    f();
  }

  C.olharLivre = function (v) { olhar.ativo = !!v; };
  C.congelar = function (v) { C.congelado = !!v; };

  /** câmera lenta: o momento crítico continua acontecendo, só mais devagar. */
  var lenta = { fator: 1, ate: 0 };
  C.camaraLenta = function (fator, segundos) {
    lenta.fator = fator || 0.22;
    lenta.ate = performance.now() + (segundos || 2.2) * 1000;
  };
  C.velocidadeNormal = function () { lenta.fator = 1; lenta.ate = 0; };

  function ligarOlhar(dom) {
    function baixo(e) { olhar.arrastando = true; var p = e.touches ? e.touches[0] : e; olhar.x = p.clientX; olhar.y = p.clientY; }
    function move(e) {
      if (!olhar.arrastando || !olhar.ativo) return;
      var p = e.touches ? e.touches[0] : e;
      var dx = p.clientX - olhar.x, dy = p.clientY - olhar.y;
      olhar.x = p.clientX; olhar.y = p.clientY;
      olhar.yaw = MU.clamp(olhar.yaw - dx * 0.0024, -LIM_YAW, LIM_YAW);
      olhar.pitch = MU.clamp(olhar.pitch - dy * 0.0024, -LIM_PITCH, LIM_PITCH);
      if (e.cancelable) e.preventDefault();
    }
    function cima() { olhar.arrastando = false; }
    dom.addEventListener('mousedown', baixo);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', cima);
    dom.addEventListener('touchstart', baixo, { passive: true });
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', cima);
  }

  /* --------------------------------------------------------------- quedas */
  var GRAV = 9.81;

  /** faz um objeto cair de verdade, com gravidade e giro. devolve promessa. */
  C.cair = function (nome, opc) {
    opc = opc || {};
    var o = typeof nome === 'string' ? C.porNome[nome] : nome;
    if (!o) return Promise.resolve();
    o.visible = true;
    if (opc.de) o.position.set(opc.de.x, opc.de.y, opc.de.z);
    var q = {
      obj: o, v: new THREE.Vector3(opc.vx || 0, opc.vy || 0, opc.vz || 0),
      giro: new THREE.Vector3(opc.giroX === undefined ? 3.2 : opc.giroX, opc.giroY || 1.1, opc.giroZ || 2.0),
      chao: (opc.chao === undefined) ? 0.03 : opc.chao,
      parar_em: opc.parar_em,        // altura onde congela (o "congelar antes do impacto")
      t: 0, aoFim: null, ativo: true
    };
    quedas.push(q);
    // prazo de relógio, para a aba em segundo plano não travar a prova
    var alvoQ = (opc.parar_em !== undefined) ? opc.parar_em : q.chao;
    var altura = Math.max(0.2, o.position.y - alvoQ);
    var prazo = Math.sqrt(2 * altura / 9.81) + 2.5;
    return new Promise(function (ok) {
      q.aoFim = ok;
      q.relogio = setTimeout(function () {
        if (!q.ativo) return;
        q.obj.position.y = alvoQ;
        q.ativo = false;
        var i = quedas.indexOf(q);
        if (i >= 0) quedas.splice(i, 1);
        if (q.aoFim) { q.aoFim(); q.aoFim = null; }
      }, prazo * 1000);
    });
  };

  C.pararQuedas = function () {
    quedas.forEach(function (q) {
      q.ativo = false;
      if (q.relogio) clearTimeout(q.relogio);
      if (q.aoFim) { q.aoFim(); q.aoFim = null; }
    });
    quedas.length = 0;
    Object.keys(C.atores).forEach(function (n) {
      var a = C.atores[n];
      a.reiniciar();
      if (!a.ehFigurante) a.tocar(C.porNome[n].userData.tarefa_fixa ||
        (raiz.Anim.CLIP_DA_POSE || {})[C.porNome[n].userData.pose] || 'parado');
    });
  };

  function atualizarQuedas(dt) {
    for (var i = quedas.length - 1; i >= 0; i--) {
      var q = quedas[i];
      if (!q.ativo || C.congelado) continue;
      q.t += dt;
      q.v.y -= GRAV * dt;
      q.obj.position.x += q.v.x * dt;
      q.obj.position.y += q.v.y * dt;
      q.obj.position.z += q.v.z * dt;
      q.obj.rotation.x += q.giro.x * dt;
      q.obj.rotation.y += q.giro.y * dt;
      q.obj.rotation.z += q.giro.z * dt;
      var limite = (q.parar_em !== undefined) ? q.parar_em : q.chao;
      if (q.obj.position.y <= limite) {
        q.obj.position.y = limite;
        q.ativo = false;
        if (q.relogio) clearTimeout(q.relogio);
        quedas.splice(i, 1);
        if (q.aoFim) { q.aoFim(); q.aoFim = null; }
      }
    }
  }

  /* --------------------------------------------- movimento de objetos da cena
     As pecas do canteiro tem a geometria "assada" em coordenadas de mundo (origem
     em 0,0,0), entao girar o objeto giraria tudo em torno do centro do mapa. Por
     isso todo giro aqui acontece em volta do centro visivel da propria peca. */
  var movs = [], repouso = [];            // repouso: onde cada peça já movida estava no começo
  var _mq = new THREE.Quaternion(), _me = new THREE.Euler(), _mv = new THREE.Vector3();

  /** anima uma peça do cenário em tempo real; devolve promessa que resolve no fim.
      tipo: 'tremor' (bate ao vento) | 'balanco' (pêndulo) | 'inclinar' (cede) | 'ir' (desloca) */
  C.movimentar = function (nome, opc) {
    opc = opc || {};
    var o = typeof nome === 'string' ? C.porNome[nome] : nome;
    if (!o) return Promise.resolve(false);
    o.visible = true;
    o.updateWorldMatrix(true, true);
    var m = {
      obj: o, tipo: opc.tipo || 'tremor', t: 0, dur: opc.dur || 2.4,
      amp: (opc.amp === undefined) ? 0.12 : opc.amp, freq: opc.freq || 4.0,
      eixo: opc.eixo || 'z', alvo: opc.alvo || 0, d: opc.d || null,
      volta: !!opc.volta, aoFim: null, ativo: true,
      pos0: o.position.clone(), rot0: o.rotation.clone(),
      pivo: C.centroDe(o).clone()
    };
    // o centro vem em coordenadas de mundo; position vive no espaço do pai
    if (o.parent) o.parent.worldToLocal(m.pivo);
    // guarda o repouso uma única vez: 'inclinar' e 'ir' ficam como terminaram,
    // e o jogo precisa saber como devolver tudo ao lugar numa nova partida
    var achou = false;
    for (var r = 0; r < repouso.length; r++) if (repouso[r].obj === o) { achou = true; break; }
    if (!achou) repouso.push({ obj: o, pos: m.pos0.clone(), rot: m.rot0.clone() });
    _mq.setFromEuler(m.rot0);
    m.local = m.pivo.clone().sub(m.pos0).applyQuaternion(_mq.clone().invert());
    movs.push(m);
    return new Promise(function (ok) { m.aoFim = ok; });
  };

  C.pararMovimentos = function () {
    movs.forEach(function (m) { if (m.aoFim) { m.aoFim(true); m.aoFim = null; } });
    movs.length = 0;
    repouso.forEach(function (r) { r.obj.position.copy(r.pos); r.obj.rotation.copy(r.rot); });
  };

  function girar(m, dx, dy, dz) {
    _me.set(m.rot0.x + dx, m.rot0.y + dy, m.rot0.z + dz);
    _mq.setFromEuler(_me);
    _mv.copy(m.local).applyQuaternion(_mq);
    m.obj.rotation.copy(_me);
    m.obj.position.set(m.pivo.x - _mv.x, m.pivo.y - _mv.y, m.pivo.z - _mv.z);
  }

  function atualizarMovs(dt) {
    for (var i = movs.length - 1; i >= 0; i--) {
      var m = movs[i];
      if (!m.ativo || C.congelado) continue;
      m.t += dt;
      var u = Math.min(1, m.t / m.dur), ang = 0;
      var env = Math.max(0, Math.min(1, u * 6, (1 - u) * 5));   // entra e sai sem solavanco
      if (m.tipo === 'tremor') {
        ang = m.amp * env * Math.sin(m.t * m.freq * 6.283) * (0.55 + 0.45 * Math.sin(m.t * 1.7));
      } else if (m.tipo === 'balanco') {
        ang = m.amp * env * Math.sin(m.t * m.freq * 6.283) * Math.exp(-m.t * 0.55);
      } else if (m.tipo === 'inclinar') {
        var e = u * u * (3 - 2 * u);
        ang = m.alvo * e + m.amp * Math.sin(m.t * 9.0) * (1 - e);
      }
      if (m.tipo === 'ir' && m.d) {
        var f = u * u * (3 - 2 * u);
        m.obj.position.set(m.pos0.x + m.d.x * f, m.pos0.y + (m.d.y || 0) * f, m.pos0.z + m.d.z * f);
      } else if (m.eixo === 'x') { girar(m, ang, 0, 0); }
      else if (m.eixo === 'y') { girar(m, 0, ang, 0); }
      else { girar(m, 0, 0, ang); }
      if (u >= 1) {
        // balanço e tremor são oscilações em volta do repouso: voltam ao lugar.
        // inclinar e ir são mudanças de verdade: ficam como terminaram.
        if (m.volta || m.tipo === 'tremor' || m.tipo === 'balanco') {
          m.obj.position.copy(m.pos0); m.obj.rotation.copy(m.rot0);
        }
        m.ativo = false;
        movs.splice(i, 1);
        if (m.aoFim) { m.aoFim(true); m.aoFim = null; }
      }
    }
  }

  /* ---------------------------------------------------- talabarte dinâmico */
  function criarCorda(ator, alvoMundo) {
    var geo = new THREE.CylinderGeometry(0.016, 0.016, 1, 5, 1, true);
    geo.translate(0, -0.5, 0);
    var mat = new THREE.MeshLambertMaterial({ color: 0xd06a1e });
    var m = new THREE.Mesh(geo, mat);
    m.name = ator.raiz.name + '_Corda';
    m.castShadow = true;
    cena.add(m);
    cordas.push({ malha: m, ator: ator, alvo: new THREE.Vector3(alvoMundo[0], alvoMundo[2], -alvoMundo[1]) });
    C.porNome[m.name] = m;
  }

  var cA = new THREE.Vector3(), cB = new THREE.Vector3(), cD = new THREE.Vector3();
  function atualizarCordas() {
    for (var i = 0; i < cordas.length; i++) {
      var c = cordas[i];
      var vis = c.ator.raiz.visible;
      c.malha.visible = vis;
      if (!vis) continue;
      var peito = c.ator.pecas.Torso || c.ator.raiz;
      peito.getWorldPosition(cA);
      cA.y += 0.28;
      cB.copy(c.alvo);
      cD.subVectors(cB, cA);
      var len = cD.length();
      if (len < 0.01) continue;
      c.malha.position.copy(cA);
      c.malha.scale.set(1, len, 1);
      c.malha.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), cD.normalize());
    }
  }

  /* ------------------------------------------------------------- desenho */
  function suave(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  var qTmp = new THREE.Quaternion(), eTmp = new THREE.Euler();
  var pFrente = new THREE.Vector3(), qCam = new THREE.Quaternion(), mCam = new THREE.Matrix4();
  // orientação do caminhar guardada à parte: o olhar livre é somado a ela a cada
  // quadro, nunca acumulado em cima do que já tinha olhado (senão a câmera roda sem parar)
  var qAndando = new THREE.Quaternion();
  var alvoSeguir = new THREE.Vector3(), posSeguir = new THREE.Vector3();

  /** empurra a câmera para fora de quem estiver colado nela. */
  var _ac = new THREE.Vector3();
  function afastarDeCorpos(minimo) {
    var m = minimo || 1.2, nomes = Object.keys(C.atores), i;
    for (i = 0; i < nomes.length; i++) {
      var a = C.atores[nomes[i]];
      if (!a.raiz.visible) continue;
      var dy = camera.position.y - (a.raiz.position.y + 1.0);
      if (dy > 1.3 || dy < -1.3) continue;
      _ac.set(camera.position.x - a.raiz.position.x, 0, camera.position.z - a.raiz.position.z);
      var d = _ac.length();
      if (d > m) continue;
      if (d < 0.001) { _ac.set(0, 0, 1); d = 0.001; }
      _ac.multiplyScalar((m - d) / d);
      camera.position.x += _ac.x;
      camera.position.z += _ac.z;
    }
  }

  function aplicarOlharLivre() {
    eTmp.set(olhar.pitch, olhar.yaw, 0, 'YXZ');
    qTmp.setFromEuler(eTmp);
    camera.quaternion.multiply(qTmp);
  }

  /** um passo de simulação (bonecos, quedas, peças em movimento, talabartes).
      O laço de render chama isto a cada quadro; fica exposto para poder testar. */
  C.passo = function (dt) {
    if (!C.congelado) {
      if (raiz.Anim) raiz.Anim.atualizar(dt);
      atualizarQuedas(dt);
      atualizarMovs(dt);
    }
    atualizarCordas();
  };

  /** desenha um quadro agora (útil para conferir a cena com o painel parado). */
  C.desenhar = function () { if (renderer) renderer.render(cena, camera); };

  /** posiciona a câmera à mão, para inspeção. */
  C.olharDe = function (de, para) {
    modo = 'livre';
    camera.position.set(de[0], de[1], de[2]);
    camera.lookAt(new THREE.Vector3(para[0], para[1], para[2]));
    camera.fov = 45; camera.updateProjectionMatrix();
  };

  function animar() {
    requestAnimationFrame(animar);
    if (!renderer) return;
    var dt = Math.min(0.06, relogio.getDelta());
    if (lenta.ate) {
      if (performance.now() > lenta.ate) { lenta.fator = 1; lenta.ate = 0; }
      else dt *= lenta.fator;
    }
    C.passo(dt);

    if (modo === 'trilho' && viagem.t < 1) {
      viagem.t = Math.min(1, viagem.t + dt / viagem.dur);
      var k = suave(viagem.t);
      camera.position.lerpVectors(origem.pos, alvo.pos, k);
      camera.quaternion.copy(origem.quat).slerp(alvo.quat, k);
      camera.fov = origem.fov + (alvo.fov - origem.fov) * k;
      camera.updateProjectionMatrix();
      if (viagem.t >= 1) concluir();

    } else if (modo === 'caminhada' && passeio) {
      var destino = passeio.pontos[passeio.i];
      pFrente.set(destino.x - camera.position.x, 0, destino.z - camera.position.z);
      var d = pFrente.length();
      if (d < 0.14) {
        passeio.i++;
        if (passeio.i >= passeio.pontos.length) { fimPasseio(); }
      } else {
        pFrente.divideScalar(d);
        var passo = Math.min(d, passeio.vel * dt);
        camera.position.x += pFrente.x * passo;
        camera.position.z += pFrente.z * passo;
        var alvoY = destino.y + Math.sin(passeio.fase * 2) * 0.028;
        camera.position.y += (alvoY - camera.position.y) * Math.min(1, dt * 4);
        passeio.fase += dt * passeio.vel * 3.4;
        // olha para onde anda; perto do fim, assume o enquadramento da cena
        mCam.lookAt(camera.position, new THREE.Vector3(destino.x, camera.position.y, destino.z), camera.up);
        qCam.setFromRotationMatrix(mCam);
        var restante = d + (passeio.pontos.length - passeio.i - 1) * 2.0;
        var mistura = MU.clamp(1 - restante / 3.2, 0, 1);
        qCam.slerp(passeio.quatFinal, mistura);
        qAndando.slerp(qCam, Math.min(1, dt * 3.2));
        camera.quaternion.copy(qAndando);
        aplicarOlharLivre();
      }

    } else if (modo === 'seguir' && perseguir) {
      if (perseguir.mundo) { perseguir.obj.getWorldPosition(alvoSeguir); alvoSeguir.add(perseguir.desvio); }
      else { alvoSeguir.copy(perseguir.obj.position).add(perseguir.desvio); }
      posSeguir.copy(alvo.pos);
      camera.position.lerp(posSeguir, Math.min(1, dt * 2));
      afastarDeCorpos(1.25);          // a câmera nunca entra dentro de um boneco
      mCam.lookAt(camera.position, alvoSeguir, camera.up);
      qCam.setFromRotationMatrix(mCam);
      // acompanha, mas sem perder o enquadramento da cena: no máximo ~35 graus
      var ang = qCam.angleTo(alvo.quat);
      if (ang > 0.62) qCam.slerp(alvo.quat, 1 - 0.62 / ang);
      camera.quaternion.slerp(qCam, Math.min(1, dt * perseguir.suav));

    } else if (C.camAtual) {
      camera.position.copy(alvo.pos);
      camera.quaternion.copy(alvo.quat);
      aplicarOlharLivre();
    }
    renderer.render(cena, camera);
  }

  C.cena = function () { return cena; };
  C.camera = function () { return camera; };
  raiz.Cena3D = C;
})(window);
