// ==UserScript==
// @name         JanoiBots
// @version      2
// @description  Bots for Agar.io Working on Delta extension developed by Storm
// @icon         https://i.imgur.com/xG5H6eL.png
// @match        *://agar.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const VIRUS_BASE_SIZE = 134;
    const VIRUS_MULTIPLIER = 0.99;
    const NEAR_MOUSE_DIST_SQ = 6760000;
    const BOT_AVOID_MULTIPLIER = 2.2;
    const SPLIT_SIZE_RATIO = 0.9;
    const AI_MOVE_INTERVAL = 50;
    const MAX_BOTS = 200;
    const ZONE_RADIUS = 2500;
    const MIN_ENEMY_SIZE_RATIO = 0.5;
    const SMART_SPLIT_RATIO = 0.9;

    class Entity {
        constructor() {
            this.id = 0;
            this.x = 0;
            this.y = 0;
            this.size = 0;
            this.name = "";
            this.isVirus = false;
            this.isPellet = false;
            this.isFriend = false;
        }
    }

    class Reader {
        constructor(buffer) {
            this.dataView = new DataView(buffer);
            this.byteOffset = 0;
        }
        readUint8() { return this.dataView.getUint8(this.byteOffset++); }
        readUint16() { const value = this.dataView.getUint16(this.byteOffset, true); this.byteOffset += 2; return value; }
        readInt32() { const value = this.dataView.getInt32(this.byteOffset, true); this.byteOffset += 4; return value; }
        readUint32() { const value = this.dataView.getUint32(this.byteOffset, true); this.byteOffset += 4; return value; }
        readFloat64() { const value = this.dataView.getFloat64(this.byteOffset, true); this.byteOffset += 8; return value; }
        readString() {
            let result = "";
            let charCode;
            while ((charCode = this.readUint8()) !== 0) {
                result += String.fromCharCode(charCode);
            }
            return result;
        }
    }

    class Writer {
        constructor(size = 1000) {
            this.dataView = new DataView(new ArrayBuffer(size));
            this.byteOffset = 0;
        }
        ensureCapacity(additionalSize) {
            if (this.byteOffset + additionalSize > this.dataView.buffer.byteLength) {
                const newBuffer = new ArrayBuffer(this.dataView.buffer.byteLength * 2);
                new Uint8Array(newBuffer).set(new Uint8Array(this.dataView.buffer));
                this.dataView = new DataView(newBuffer);
            }
        }
        writeUint8(value) {
            this.ensureCapacity(1);
            this.dataView.setUint8(this.byteOffset++, value);
        }
        writeUint16(value) {
            this.ensureCapacity(2);
            this.dataView.setUint16(this.byteOffset, value, true);
            this.byteOffset += 2;
        }
        writeInt32(value) {
            this.ensureCapacity(4);
            this.dataView.setInt32(this.byteOffset, value, true);
            this.byteOffset += 4;
        }
        writeUint32(value) {
            this.ensureCapacity(4);
            this.dataView.setUint32(this.byteOffset, value, true);
            this.byteOffset += 4;
        }
        writeString(str) {
            this.ensureCapacity(str.length + 1);
            for (let i = 0; i < str.length; i++) {
                this.writeUint8(str.charCodeAt(i));
            }
            this.writeUint8(0);
        }
        toBuffer() {
            return this.dataView.buffer.slice(0, this.byteOffset);
        }
    }

    class Bot {
        constructor(config, index) {
            this.config = config;
            this.index = index;
            this.ws = null;
            this.offsetX = 0;
            this.offsetY = 0;
            this.moveInt = null;
            this.stopped = false;
            this.isAlive = false;
            this.connected = false;
            this.playerCells = new Map();
            this.encryptionKey = 0;
            this.decryptionKey = 0;
            this.serverVersion = null;
            this.followMouse = !config.vShield && !config.botAi;
            this.myCellIDs = [];
            this.clientVersion = 31116;
            this.protocolVersion = 23;
            this.reconnectTimeout = null;
            this.connectionAttempts = 0;
            this.maxConnectionAttempts = 3;
            this.isReconnecting = false;
            this.name = localStorage.getItem("janoi-bot-name") || "Janoi-Bots";
            this.lastMoveTime = 0;
            this.claimedPellets = new Set();
            this.targetZone = { x: 0, y: 0 };
            this.assignZone();
            this.connect();
        }

        assignZone() {
            const angle = (this.index * 2.4) % (Math.PI * 2);
            const radius = ZONE_RADIUS + (this.index % 5) * 500;
            this.targetZone.x = Math.cos(angle) * radius;
            this.targetZone.y = Math.sin(angle) * radius;
        }

        reset() {
            this.ws = null;
            this.offsetX = 0;
            this.offsetY = 0;
            this.isAlive = false;
            this.connected = false;
            this.playerCells.clear();
            this.encryptionKey = 0;
            this.decryptionKey = 0;
            this.serverVersion = null;
            this.followMouse = !this.config.vShield && !this.config.botAi;
            this.myCellIDs = [];
            this.claimedPellets.clear();
        }

        connect() {
            this.reset();
            if (!this.stopped && this.config.startedBots) {
                this.ws = new WebSocket(this.config.agarServer);
                this.ws.binaryType = "arraybuffer";
                this.ws.onopen = () => this.onopen();
                this.ws.onclose = () => this.onclose();
                this.ws.onerror = () => this.onerror();
                this.ws.onmessage = (e) => this.onmessage(e);
                this.connected = true;
                this.connectionAttempts++;
                setTimeout(() => {
                    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                        this.ws.close();
                    }
                }, 10000);
            }
        }

        onopen() {
            this.sendProtocolVersion();
            this.sendClientVersion();
        }

        onclose() {
            this.handleReconnection();
            this.connected = false;
        }

        onerror() {
            setTimeout(() => {
                if (this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.close();
                }
            }, 1000);
        }

        send(data) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                if (this.encryptionKey) {
                    data = this.xorBuffer(data, this.encryptionKey);
                    this.encryptionKey = this.rotateKey(this.encryptionKey);
                }
                this.ws.send(data);
            }
        }

        onmessage(event) {
            let data = event.data;
            if (this.decryptionKey) {
                data = this.xorBuffer(data, this.decryptionKey ^ this.clientVersion);
            }
            this.handleBuffer(data);
        }

        handleBuffer(buffer) {
            const reader = new Reader(buffer);
            const opcode = reader.readUint8();
            switch (opcode) {
                case 18:
                    setTimeout(() => this.ws.close(), 1000);
                    break;
                case 32:
                    this.myCellIDs.push(reader.readUint32());
                    if (!this.isAlive) {
                        this.isAlive = true;
                        this.moveInt = setInterval(() => this.move(this.config.cords), AI_MOVE_INTERVAL);
                    }
                    break;
                case 85:
                    setTimeout(() => {
                        this.connect();
                        setTimeout(() => {
                            const index = Bots.indexOf(this);
                            if (index !== -1) {
                                Bots[index] = new Bot(this.config, index);
                            }
                        }, 700);
                    }, 1000);
                    break;
                case 241:
                    this.decryptionKey = reader.readUint32();
                    this.serverVersion = reader.readString();
                    const match = this.config.agarServer.match(/wss:\/\/(web-arenas-live-[\w-]+\.agario\.miniclippt\.com\/[\w-]+\/[\d-]+)/);
                    if (match) {
                        this.encryptionKey = this.murmur2(match[1] + this.serverVersion, 255);
                    }
                    break;
                case 242:
                    this.sendSpawn();
                    break;
                case 255:
                    this.handleMessage(this.uncompressMessage(
                        new Uint8Array(reader.dataView.buffer.slice(5)),
                        new Uint8Array(reader.readUint32())
                    ).buffer);
                    break;
            }
        }

        handleMessage(buffer) {
            const reader = new Reader(buffer);
            const opcode = reader.readUint8();
            switch (opcode) {
                case 16:
                    this.updateNodes(reader);
                    break;
                case 64:
                    this.updateOffset(reader);
                    break;
            }
        }

        updateOffset(reader) {
            const minX = reader.readFloat64();
            const minY = reader.readFloat64();
            const maxX = reader.readFloat64();
            const maxY = reader.readFloat64();
            if (maxX - minX > 14000) this.offsetX = (maxX + minX) / 2;
            if (maxY - minY > 14000) this.offsetY = (maxY + minY) / 2;
        }

        updateNodes(reader) {
            const nodeCount = reader.readUint16();
            for (let i = 0; i < nodeCount; i++) {
                reader.byteOffset += 8;
            }
            let entityId;
            while ((entityId = reader.readUint32()) !== 0) {
                const entity = new Entity();
                entity.id = entityId;
                entity.x = reader.readInt32();
                entity.y = reader.readInt32();
                entity.size = reader.readUint16();
                const flags = reader.readUint8();
                const extendedFlags = flags & 128 ? reader.readUint8() : 0;
                if (flags & 1) entity.isVirus = true;
                if (flags & 2) reader.byteOffset += 3;
                if (flags & 4) reader.readString();
                if (flags & 8) entity.name = decodeURIComponent(escape(reader.readString()));
                if (extendedFlags & 1) entity.isPellet = true;
                if (extendedFlags & 2) entity.isFriend = true;
                if (extendedFlags & 4) reader.byteOffset += 4;
                this.playerCells.set(entity.id, entity);
            }
            const removedNodeCount = reader.readUint16();
            for (let i = 0; i < removedNodeCount; i++) {
                const removedId = reader.readUint32();
                const idx = this.myCellIDs.indexOf(removedId);
                if (idx !== -1) this.myCellIDs.splice(idx, 1);
                this.playerCells.delete(removedId);
                this.claimedPellets.delete(removedId);
            }
            if (this.isAlive && this.myCellIDs.length === 0) {
                this.isAlive = false;
                this.followMouse = !this.config.vShield && !this.config.botAi;
                this.sendSpawn();
            }
        }

        findClosest(type, x, y, size) {
            let minDistSq = Infinity;
            let closest = null;
            for (const entity of this.playerCells.values()) {
                let valid = false;
                switch (type) {
                    case 'bigger':
                        valid = !entity.isVirus && !entity.isPellet && !entity.isFriend && entity.size > size * 1.15 && entity.name !== this.name;
                        break;
                    case 'smaller':
                        valid = !entity.isVirus && !entity.isPellet && !entity.isFriend && entity.size <= size * SMART_SPLIT_RATIO && entity.name !== this.name;
                        break;
                    case 'pellet':
                        if (!entity.isPellet || entity.isVirus) break;
                        if (this.config.botAi) {
                            let claimed = false;
                            for (const bot of Bots) {
                                if (bot !== this && bot.isAlive && bot.claimedPellets.has(entity.id)) {
                                    claimed = true;
                                    break;
                                }
                            }
                            if (claimed) break;
                        }
                        valid = true;
                        break;
                    case 'virus':
                        valid = entity.isVirus && !entity.isPellet;
                        break;
                    case 'friend':
                        valid = entity.isFriend && !entity.isVirus && !entity.isPellet && entity.size > 20 && !this.myCellIDs.includes(entity.id);
                        break;
                }
                if (valid) {
                    const dx = entity.x - x;
                    const dy = entity.y - y;
                    const distSq = dx * dx + dy * dy;
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                        closest = entity;
                    }
                }
            }
            return { distSq: minDistSq, dist: minDistSq < Infinity ? Math.sqrt(minDistSq) : Infinity, entity: closest };
        }

        isNearMouse(x, y) {
            const dx = (this.config.cords.x + this.offsetX) - x;
            const dy = (this.config.cords.y + this.offsetY) - y;
            return (dx * dx + dy * dy) < NEAR_MOUSE_DIST_SQ;
        }

        move(cords) {
            const now = Date.now();
            if (now - this.lastMoveTime < AI_MOVE_INTERVAL) return;
            this.lastMoveTime = now;
            let x = 0, y = 0, size = 0;
            const count = this.myCellIDs.length;
            if (count === 0) return;
            for (const id of this.myCellIDs) {
                const cell = this.playerCells.get(id);
                if (cell) {
                    x += cell.x;
                    y += cell.y;
                    size += cell.size;
                }
            }
            x /= count;
            y /= count;
            const bigger = this.findClosest('bigger', x, y, size);
            const smaller = this.findClosest('smaller', x, y, size);
            const pellet = this.findClosest('pellet', x, y, size);
            const virus = this.findClosest('virus', x, y, size);
            const friend = this.findClosest('friend', x, y, size);
            if (this.config.vShield && virus.entity) {
                for (const id of this.myCellIDs) {
                    const cell = this.playerCells.get(id);
                    if (cell && cell.size >= 133) {
                        this.moveTo(virus.entity.x, virus.entity.y, this.decryptionKey);
                        return;
                    }
                }
            }
            if (this.followMouse) {
                if (bigger.entity && bigger.dist < size * 1.5) {
                    this.moveTo(x * 2 - bigger.entity.x, y * 2 - bigger.entity.y, this.decryptionKey);
                    return;
                }
                if (size >= 85) {
                    this.moveTo(cords.x + this.offsetX, cords.y + this.offsetY, this.decryptionKey);
                    return;
                }
                if (pellet.entity) {
                    this.moveTo(pellet.entity.x, pellet.entity.y, this.decryptionKey);
                    return;
                }
                const angle = Math.random() * 6.28;
                this.moveTo(x + Math.cos(angle) * 1000, y + Math.sin(angle) * 1000, this.decryptionKey);
            } else {
                if (bigger.entity && bigger.dist < size * 1.2 && !bigger.entity.isFriend) {
                    this.moveTo(x * 2 - bigger.entity.x, y * 2 - bigger.entity.y, this.decryptionKey);
                    this.claimedPellets.clear();
                    return;
                }
                if (virus.entity) {
                    const virusAvoidDist = (VIRUS_BASE_SIZE + size * VIRUS_MULTIPLIER);
                    if (virus.dist < virusAvoidDist) {
                        const dx = x - virus.entity.x;
                        const dy = y - virus.entity.y;
                        const len = virus.dist || 1;
                        this.moveTo(
                            x + (dx / len) * virusAvoidDist * 1.5,
                            y + (dy / len) * virusAvoidDist * 1.5,
                            this.decryptionKey
                        );
                        this.claimedPellets.clear();
                        return;
                    }
                }
                if (friend.entity && friend.distSq < ((size + friend.entity.size) * BOT_AVOID_MULTIPLIER) ** 2) {
                    const dx = x - friend.entity.x;
                    const dy = y - friend.entity.y;
                    const len = Math.sqrt(friend.distSq) || 1;
                    const escapeStrength = Math.sqrt(((size + friend.entity.size) * BOT_AVOID_MULTIPLIER) ** 2) * 2;
                    this.moveTo(
                        x + (dx / len) * escapeStrength,
                        y + (dy / len) * escapeStrength,
                        this.decryptionKey
                    );
                    return;
                }
                if (smaller.entity && smaller.dist < size * 4 && !smaller.entity.isFriend) {
                    this.moveTo(smaller.entity.x, smaller.entity.y, this.decryptionKey);
                    this.claimedPellets.clear();
                    return;
                }
                if (count > 1) {
                    if (pellet.entity) {
                        this.claimedPellets.add(pellet.entity.id);
                        this.moveTo(pellet.entity.x, pellet.entity.y, this.decryptionKey);
                    } else {
                        const angle = Math.random() * 6.28;
                        this.moveTo(x + Math.cos(angle) * 400, y + Math.sin(angle) * 400, this.decryptionKey);
                    }
                    return;
                }
                if (pellet.entity) {
                    this.claimedPellets.add(pellet.entity.id);
                    this.moveTo(pellet.entity.x, pellet.entity.y, this.decryptionKey);
                    return;
                }
                const zx = this.targetZone.x + this.offsetX;
                const zy = this.targetZone.y + this.offsetY;
                const dzx = zx - x;
                const dzy = zy - y;
                const dzDist = Math.sqrt(dzx * dzx + dzy * dzy);
                if (dzDist > 300) {
                    this.moveTo(zx, zy, this.decryptionKey);
                } else {
                    this.assignZone();
                }
            }
        }

        sendProtocolVersion() {
            const writer = new Writer(5);
            writer.writeUint8(254);
            writer.writeUint32(this.protocolVersion);
            if (this.ws) this.ws.send(new Uint8Array(writer.dataView.buffer).buffer);
        }

        sendClientVersion() {
            const writer = new Writer(5);
            writer.writeUint8(255);
            writer.writeUint32(this.clientVersion);
            if (this.ws) this.ws.send(new Uint8Array(writer.dataView.buffer).buffer);
        }

        sendSpawn() {
            const writer = new Writer(this.name.length * 3);
            writer.writeUint8(0);
            writer.writeString(this.name);
            this.send(new Uint8Array(writer.dataView.buffer).buffer);
        }

        moveTo(x, y, key) {
            const writer = new Writer(13);
            writer.writeUint8(16);
            writer.writeInt32(x);
            writer.writeInt32(y);
            writer.writeUint32(key);
            this.send(new Uint8Array(writer.dataView.buffer).buffer);
        }

        split() {
            if (!this.isAlive) return;
            if (!this.followMouse) return;
            for (const id of this.myCellIDs) {
                const cell = this.playerCells.get(id);
                if (cell && cell.size >= 80 && this.isNearMouse(cell.x, cell.y)) {
                    this.send(new Uint8Array([17]).buffer);
                    return;
                }
            }
        }

        eject() {
            if (!this.isAlive) return;
            if (this.followMouse) {
                for (const id of this.myCellIDs) {
                    const cell = this.playerCells.get(id);
                    if (cell && cell.size >= 80 && this.isNearMouse(cell.x, cell.y)) {
                        this.send(new Uint8Array([21]).buffer);
                        return;
                    }
                }
            } else {
                let totalSize = 0;
                for (const id of this.myCellIDs) {
                    const cell = this.playerCells.get(id);
                    if (cell) totalSize += cell.size;
                }
                if (totalSize / this.myCellIDs.length >= 80) {
                    this.send(new Uint8Array([21]).buffer);
                }
            }
        }

        rotateKey(key) {
            key = Math.imul(key, 1540483477) >> 0;
            key = Math.imul(key >>> 24 ^ key, 1540483477) >> 0 ^ 114296087;
            key = Math.imul(key >>> 13 ^ key, 1540483477) >> 0;
            return key >>> 15 ^ key;
        }

        xorBuffer(buffer, key) {
            const dataView = new DataView(buffer);
            for (let i = 0; i < dataView.byteLength; i++) {
                dataView.setUint8(i, dataView.getUint8(i) ^ key >>> i % 4 * 8 & 255);
            }
            return buffer;
        }

        uncompressMessage(compressed, output) {
            for (let i = 0, j = 0; i < compressed.length;) {
                const token = compressed[i++];
                let literalLength = token >> 4;
                if (literalLength > 0) {
                    let extendedLength = literalLength + 240;
                    while (extendedLength === 255) {
                        extendedLength = compressed[i++];
                        literalLength += extendedLength;
                    }
                    const end = i + literalLength;
                    while (i < end) output[j++] = compressed[i++];
                    if (i === compressed.length) return output;
                }
                const offset = compressed[i++] | compressed[i++] << 8;
                if (offset === 0 || offset > j) return -(i - 2);
                let matchLength = token & 15;
                let extendedLength = matchLength + 240;
                while (extendedLength === 255) {
                    extendedLength = compressed[i++];
                    matchLength += extendedLength;
                }
                let pos = j - offset;
                const end = j + matchLength + 4;
                while (j < end) output[j++] = output[pos++];
            }
            return output;
        }

        murmur2(str, seed) {
            let length = str.length;
            let h = seed ^ length;
            let i = 0;
            while (length >= 4) {
                let k = str.charCodeAt(i) & 255 |
                       (str.charCodeAt(++i) & 255) << 8 |
                       (str.charCodeAt(++i) & 255) << 16 |
                       (str.charCodeAt(++i) & 255) << 24;
                k = (k & 65535) * 1540483477 + (((k >>> 16) * 1540483477 & 65535) << 16);
                k ^= k >>> 24;
                k = (k & 65535) * 1540483477 + (((k >>> 16) * 1540483477 & 65535) << 16);
                h = (h & 65535) * 1540483477 + (((h >>> 16) * 1540483477 & 65535) << 16) ^ k;
                length -= 4;
                ++i;
            }
            switch (length) {
                case 3: h ^= (str.charCodeAt(i + 2) & 255) << 16;
                case 2: h ^= (str.charCodeAt(i + 1) & 255) << 8;
                case 1: h ^= str.charCodeAt(i) & 255;
                    h = (h & 65535) * 1540483477 + (((h >>> 16) * 1540483477 & 65535) << 16);
            }
            h ^= h >>> 13;
            h = (h & 65535) * 1540483477 + (((h >>> 16) * 1540483477 & 65535) << 16);
            h ^= h >>> 15;
            return h >>> 0;
        }

        handleReconnection() {
            if (!this.isReconnecting && !this.config.stoppedBots && !this.stopped &&
                this.connectionAttempts < this.maxConnectionAttempts) {
                this.isReconnecting = true;
                this.reconnectTimeout = setTimeout(() => {
                    this.isReconnecting = false;
                    this.connect();
                }, 1000);
            } else if (this.connectionAttempts >= this.maxConnectionAttempts) {
                const index = Bots.indexOf(this);
                if (index !== -1) {
                    Bots[index] = new Bot(this.config, index);
                }
            }
        }

        stop() {
            clearInterval(this.moveInt);
            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
            this.stopped = true;
            this.connected = false;
        }
    }

    let botCounter = null;
    let botCreationInterval = null;
    let isStarting = false;
    let isStopping = false;
    let isInverted = false;
    let isCapsule = false;

    const botConfig = {
        botAi: false,
        vShield: false,
        keybinds: {
            modeKey: "F",
            feedKey: "C",
            splitKey: "X",
            vShieldKey: "V"
        },
        cords: { x: 0, y: 0 },
        botCount: parseInt(localStorage.getItem('botAmount')) || 150,
        agarServer: null,
        stoppedBots: true,
        startedBots: false
    };

    const Bots = [];

    function startBots(action) {
        if (isStarting || isStopping) return;
        if (action === 'stfinish' && !botConfig.startedBots && botConfig.stoppedBots) {
            isStarting = true;
            botConfig.startedBots = true;
            botConfig.stoppedBots = false;
            updateBotCount();
            botCounter = setInterval(() => {
                const aliveBots = Bots.filter(bot => bot.isAlive).length;
                const connectedBots = Bots.filter(bot => bot.connected).length;
                const botCountEl = document.querySelector(".Janoi-botCount");
                if (botCountEl) botCountEl.textContent = `${aliveBots}/${connectedBots}`;
            }, 500);
            const startBtn = document.querySelector(".Janoi-stfinish");
            const stopBtn = document.querySelector(".Janoi-stop");
            if (startBtn && stopBtn) {
                startBtn.style.display = "none";
                stopBtn.style.display = "inline-block";
            }
            updateCapsuleButtons();
            updateNormalButtons();
            isStarting = false;
        } else if (action === 'stop' && botConfig.startedBots) {
            isStopping = true;
            const reduceBots = setInterval(() => {
                if (Bots.length > 0) {
                    Bots.pop().stop();
                } else {
                    clearInterval(reduceBots);
                    clearInterval(botCounter);
                    botCounter = null;
                    botConfig.botAi = false;
                    botConfig.vShield = false;
                    botConfig.stoppedBots = true;
                    botConfig.startedBots = false;
                    const startBtn = document.querySelector(".Janoi-stfinish");
                    const stopBtn = document.querySelector(".Janoi-stop");
                    const botCountEl = document.querySelector(".Janoi-botCount");
                    if (startBtn && stopBtn) {
                        startBtn.style.display = "inline-block";
                        stopBtn.style.display = "none";
                    }
                    if (botCountEl) botCountEl.textContent = `0/${botConfig.botCount}`;
                    updateAIButton();
                    updateVShieldButton();
                    updateCapsuleButtons();
                    updateNormalButtons();
                    isStopping = false;
                }
            }, 10);
        }
    }

    function updateBotCount() {
        if (!botConfig.startedBots) return;
        clearInterval(botCreationInterval);
        const currentBotCount = Bots.length;
        const targetBotCount = botConfig.botCount;
        if (currentBotCount < targetBotCount) {
            let botCount = currentBotCount;
            botCreationInterval = setInterval(() => {
                if (botCount < targetBotCount && botConfig.startedBots) {
                    Bots.push(new Bot(botConfig, botCount));
                    botCount++;
                } else {
                    clearInterval(botCreationInterval);
                    botCreationInterval = null;
                }
            }, 600);
        } else if (currentBotCount > targetBotCount) {
            while (Bots.length > targetBotCount) {
                Bots.pop().stop();
            }
        }
    }

    const injectScript = () => {
        createContainer();
        loadStylesheet();
        initUI();
        initEventListeners();
        initWebSocket();
        initInterval();
    };

    const panelId = "Janoibots_" + Math.floor(100 + Math.random() * 900);

    const createContainer = () => {
        const container = document.createElement("div");
        container.id = panelId;
        (document.body || document.documentElement).appendChild(container);
    };

    const loadStylesheet = () => {
        const style = document.createElement("style");
        style.textContent =
            `.Janoi-info-panel {
                position: fixed;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(20, 20, 25, 0.92);
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-radius: 16px;
                padding: 10px 16px;
                display: flex;
                align-items: center;
                gap: 12px;
                z-index: 99999999;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                transition: all 0.75s ease;
            }
            .Janoi-info-panel.inverted {
                background: rgba(240, 240, 240, 0.92);
                border-color: rgba(0, 0, 0, 0.15);
            }
            .Janoi-info-panel.capsule {
                width: auto;
                padding: 6px 10px;
                gap: 6px;
            }
            .bot-text {
                color: #fff;
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
            }
            .Janoi-info-panel.inverted .bot-text {
                color: #333;
            }
            .Janoi-author {
                color: #ffffff;
                text-decoration: none;
                font-weight: 600;
                font-size: 13px;
                white-space: nowrap;
            }
            .Janoi-author:hover {
                text-decoration: underline;
            }
            .Janoi-info-panel.inverted .Janoi-author {
                color: #000000;
            }
            .Janoi-info-panel.capsule .Janoi-author {
                display: none;
            }
            .bot-button {
                background: linear-gradient(135deg, #8495e6 0%, #2846ce 100%);
                color: #fff;
                border: none;
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 10px;
                font-size: 13px;
                font-weight: 600;
                transition: all 0.2s ease;
            }
            .bot-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
            }
            .bot-button:active {
                transform: translateY(0);
            }
            .Janoi-stop {
                background: linear-gradient(135deg, #93a3fb 0%, #5789f5 100%);
            }
            .Janoi-stop:hover {
                box-shadow: 0 4px 12px rgba(245, 87, 108, 0.4);
            }
            .small-button {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.2s ease;
            }
            .small-button:hover {
                background: rgba(255, 255, 255, 0.15);
                transform: translateY(-1px);
            }
            .small-button.active {
                background: linear-gradient(135deg, #93abfb 0%, #5774f5 100%);
                border-color: transparent;
            }
            .Janoi-info-panel.inverted .small-button {
                background: rgba(0, 0, 0, 0.1);
                color: #333;
                border-color: rgba(0, 0, 0, 0.2);
            }
            .Janoi-info-panel.inverted .small-button:hover {
                background: rgba(0, 0, 0, 0.15);
            }
            .settings-modal {
                position: fixed;
                top: 80px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(20, 20, 25, 0.95);
                border: 2px solid rgba(255, 255, 255, 0.15);
                border-radius: 16px;
                padding: 20px;
                z-index: 100000000;
                color: #fff;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                width: 320px;
                transition: all 0.75s ease;
            }
            .settings-modal.inverted {
                background: rgba(240, 240, 240, 0.95);
                border-color: rgba(0, 0, 0, 0.15);
                color: #333;
            }
            .settings-grid {
                display: grid;
                gap: 15px;
                margin-bottom: 15px;
            }
            .settings-label {
                font-size: 13px;
                font-weight: 600;
                margin-bottom: 6px;
                color: #ccc;
                transition: all 0.75s ease;
            }
            .settings-modal.inverted .settings-label {
                color: #777;
            }
            .settings-input {
                width: 100%;
                padding: 8px 12px;
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 12px;
                color: #fff;
                font-size: 13px;
                box-sizing: border-box;
                transition: all 0.75s ease;
            }
            .settings-modal.inverted .settings-input {
                background: rgba(0, 0, 0, 0.1);
                border-color: rgba(0, 0, 0, 0.2);
                color: #333;
            }
            .settings-input:focus {
                outline: none;
                border-color: #667eea;
                background: rgba(255, 255, 255, 0.15);
                transition: all 0.2s ease;
            }
            .settings-modal.inverted .settings-input:focus {
                border-color: #5789f5;
                background: rgba(0, 0, 0, 0.15);
            }
            .keybind-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin-top: 10px;
            }
            .keybind-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .keybind-label {
                font-size: 12px;
                color: #ccc;
                transition: all 0.75s ease;
            }
            .settings-modal.inverted .keybind-label {
                color: #777;
            }
            .settings-key {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 4px 6px;
                border-radius: 8px;
                color: #fff;
                font-size: 12px;
                min-width: 20px;
                text-align: center;
                width: 25%;
                transition: all 0.75s ease;
            }
            .settings-modal.inverted .settings-key {
                background: rgba(0, 0, 0, 0.1);
                border-color: rgba(0, 0, 0, 0.2);
                color: #333;
            }
            .settings-save {
                background: linear-gradient(135deg, #002df5 0%, #5f729c 100%);
                color: #fff;
                border: none;
                padding: 10px;
                cursor: pointer;
                border-radius: 10px;
                font-size: 14px;
                font-weight: 600;
                width: 80%;
                margin: 15px auto 0;
                display: block;
                transition: all 0.2s ease;
            }
            .settings-save:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
            }
            .capsule-button {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 10px;
                cursor: pointer;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.2s ease;
                min-width: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .Janoi-info-panel.inverted .capsule-button {
                background: rgba(0, 0, 0, 0.1);
                color: #333;
                border-color: rgba(0, 0, 0, 0.2);
            }
            .capsule-button:hover {
                background: rgba(255, 255, 255, 0.15);
                transform: translateY(-1px);
            }
            .capsule-button.active {
                background: linear-gradient(135deg, #93b7fb 0%, #5796f5 100%);
                border-color: transparent;
            }
            .Janoi-info-panel.capsule .capsule-button {
                padding: 6px 8px;
                min-width: 24px;
            }
            .theme-toggle {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.2);
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .Janoi-info-panel.inverted .theme-toggle {
                background: rgba(0, 0, 0, 0.1);
                color: #333;
                border-color: rgba(0, 0, 0, 0.2);
            }
            .theme-toggle:hover {
                background: rgba(255, 255, 255, 0.15);
                transform: translateY(-1px);
            }
            .thanks-text {
                text-align: center;
                font-size: 11px;
                color: #aaa;
                margin-top: 8px;
                cursor: pointer;
                transition: all 0.75s ease;
            }
            .thanks-text:hover {
                color: #ccc;
            }
            .settings-modal.inverted .thanks-text {
                color: #777;
            }
            .settings-modal.inverted .thanks-text:hover {
                color: #555;
            }`;
        document.head.appendChild(style);
    };

    const initUI = () => {
        const panelHTML =
            `<div class="Janoi-info-panel">
                <a href="https://youtube.com/@janoi.agar1?si=uKX3RKWFuEMtcxxF" target="_blank" class="Janoi-author">JanoiBots</a>
                <div class="bot-text">Bots: <span class="Janoi-botCount">0/${botConfig.botCount}</span></div>
                <button class="bot-button Janoi-stfinish" onclick="window.startBots('stfinish')">▶Start</button>
                <button class="bot-button Janoi-stop" onclick="window.startBots('stop')" style="display:none">⏹Stop</button>
                <button class="small-button Janoi-ai-btn" onclick="window.toggleAIMode()">AI OFF</button>
                <button class="small-button Janoi-vsh-btn" onclick="window.toggleVShield()">VShd OFF</button>
                <button class="theme-toggle" onclick="window.toggleInvert()">☀️</button>
                <button class="small-button" onclick="window.toggleCapsule()">Hidden</button>
                <button class="bot-button" onclick="window.toggleSettings()">⚙</button>
            </div>`;
        document.getElementById(panelId).innerHTML = panelHTML;
    };

    const initEventListeners = () => {
        document.addEventListener("keydown", e => {
            const key = e.key.toUpperCase();
            switch (key) {
                case botConfig.keybinds.modeKey:
                    window.toggleAIMode();
                    break;
                case botConfig.keybinds.feedKey:
                    Bots.forEach(bot => bot.eject());
                    break;
                case botConfig.keybinds.splitKey:
                    Bots.forEach(bot => bot.split());
                    break;
                case botConfig.keybinds.vShieldKey:
                    window.toggleVShield();
                    break;
            }
        });
    };

    function updateVShieldButton() {
        const btn = document.querySelector(".Janoi-vsh-btn");
        if (btn) {
            btn.textContent = `VShd ${botConfig.vShield ? 'ON' : 'OFF'}`;
            btn.classList.toggle('active', botConfig.vShield);
        }
    }

    function updateAIButton() {
        const btn = document.querySelector(".Janoi-ai-btn");
        if (btn) {
            btn.textContent = `AI ${botConfig.botAi ? 'ON' : 'OFF'}`;
            btn.classList.toggle('active', botConfig.botAi);
        }
    }

    function updateNormalButtons() {
        const themeBtn = document.querySelector('.theme-toggle');
        if (themeBtn) {
            themeBtn.textContent = isInverted ? '🌙' : '☀️';
        }
    }

    window.toggleVShield = () => {
        botConfig.vShield = !botConfig.vShield;
        Bots.forEach(bot => {
            bot.followMouse = !botConfig.vShield && !botConfig.botAi;
        });
        updateVShieldButton();
        updateCapsuleButtons();
    };

    window.toggleAIMode = () => {
        botConfig.botAi = !botConfig.botAi;
        Bots.forEach(bot => {
            bot.followMouse = !botConfig.botAi && !botConfig.vShield;
            bot.claimedPellets.clear();
        });
        updateAIButton();
        updateCapsuleButtons();
    };

    window.toggleInvert = () => {
        const panel = document.querySelector('.Janoi-info-panel');
        const modal = document.querySelector('.settings-modal');
        isInverted = !isInverted;
        panel.classList.toggle('inverted', isInverted);
        if (modal) modal.classList.toggle('inverted', isInverted);
        updateNormalButtons();
        if (isCapsule) {
            const capsuleInvertBtn = document.querySelector('.Janoi-info-panel.capsule .capsule-button:nth-last-of-type(2)');
            if (capsuleInvertBtn) capsuleInvertBtn.textContent = isInverted ? '🌙' : '☀️';
        }
    };

    window.toggleCapsule = () => {
        const panel = document.querySelector('.Janoi-info-panel');
        isCapsule = !isCapsule;
        panel.classList.toggle('capsule', isCapsule);
        if (isCapsule) {
            panel.innerHTML =
                `<button class="capsule-button Janoi-start-btn" onclick="window.startBots('stfinish')">▶</button>
                <button class="capsule-button Janoi-stop-btn" onclick="window.startBots('stop')" style="display:none">⏹</button>
                <button class="capsule-button Janoi-ai-btn-capsule" onclick="window.toggleAIMode()">AI</button>
                <button class="capsule-button Janoi-vsh-btn-capsule" onclick="window.toggleVShield()">Vshd</button>
                <button class="capsule-button" onclick="window.toggleInvert()">${isInverted ? '🌙' : '☀️'}</button>
                <button class="capsule-button" onclick="window.toggleCapsule()">Show</button>`;
            updateCapsuleButtons();
        } else {
            panel.innerHTML =
                `<a href="https://youtube.com/@janoi.agar1?si=uKX3RKWFuEMtcxxF" target="_blank" class="Janoi-author">JanoiBots</a>
                <div class="bot-text">Bots: <span class="Janoi-botCount">0/${botConfig.botCount}</span></div>
                <button class="bot-button Janoi-stfinish" onclick="window.startBots('stfinish')">▶Start</button>
                <button class="bot-button Janoi-stop" onclick="window.startBots('stop')" style="display:none">■Stop</button>
                <button class="small-button Janoi-ai-btn" onclick="window.toggleAIMode()">AI OFF</button>
                <button class="small-button Janoi-vsh-btn" onclick="window.toggleVShield()">VShd OFF</button>
                <button class="theme-toggle" onclick="window.toggleInvert()">${isInverted ? '🌙' : '☀️'}</button>
                <button class="small-button" onclick="window.toggleCapsule()">Hidden</button>
                <button class="bot-button" onclick="window.toggleSettings()">⚙</button>`;
            updateAIButton();
            updateVShieldButton();
            updateNormalButtons();
            const startBtn = document.querySelector(".Janoi-stfinish");
            const stopBtn = document.querySelector(".Janoi-stop");
            if (botConfig.startedBots) {
                startBtn.style.display = 'none';
                stopBtn.style.display = 'inline-block';
            } else {
                startBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            }
        }
    };

    function updateCapsuleButtons() {
        if (!isCapsule) return;

        const startBtn = document.querySelector('.scarz-start-btn');
        const stopBtn = document.querySelector('.scarz-stop-btn');
        const aiBtn = document.querySelector('.scarz-ai-btn-capsule');
        const vshBtn = document.querySelector('.scarz-vsh-btn-capsule');

        if (startBtn && stopBtn) {
            if (botConfig.startedBots) {
                startBtn.style.display = 'none';
                stopBtn.style.display = 'flex';
            } else {
                startBtn.style.display = 'flex';
                stopBtn.style.display = 'none';
            }
        }

        if (aiBtn) {
            aiBtn.classList.toggle('active', botConfig.botAi);
        }

        if (vshBtn) {
            vshBtn.classList.toggle('active', botConfig.vShield);
        }
    }

    window.toggleSettings = () => {
        let modal = document.querySelector('.settings-modal');
        if (modal) {
            saveSettings();
            modal.remove();
        } else {
            createSettingsModal();
        }
    };

    function createSettingsModal() {
        const modal = document.createElement('div');
        modal.className = 'settings-modal';
        if (isInverted) modal.classList.add('inverted');
        modal.innerHTML =
            `<div class="settings-grid">
                <div>
                    <div class="settings-label">Bot Name:</div>
                    <input type="text" id="botName" class="settings-input" value="${localStorage.getItem('scarz-bot-name') || 'Janoi-Bots'}">
                </div>
                <div>
                    <div class="settings-label">Bot Amount 1-200 (150 is recommended):</div>
                    <input type="number" id="botAmount" class="settings-input" min="1" max="200" value="${botConfig.botCount}">
                </div>
            </div>
            <div>
                <div class="settings-label">Keybinds:</div>
                <div class="keybind-grid">
                    <div class="keybind-row">
                        <span class="keybind-label">Split:</span>
                        <input type="text" id="splitKey" class="settings-key" value="${botConfig.keybinds.splitKey}" maxlength="1">
                    </div>
                    <div class="keybind-row">
                        <span class="keybind-label">Feed:</span>
                        <input type="text" id="feedKey" class="settings-key" value="${botConfig.keybinds.feedKey}" maxlength="1">
                    </div>
                    <div class="keybind-row">
                        <span class="keybind-label">AI Mode:</span>
                        <input type="text" id="modeKey" class="settings-key" value="${botConfig.keybinds.modeKey}" maxlength="1">
                    </div>
                    <div class="keybind-row">
                        <span class="keybind-label">VShield:</span>
                        <input type="text" id="vShieldKey" class="settings-key" value="${botConfig.keybinds.vShieldKey}" maxlength="1">
                    </div>
                </div>
            </div>
            <button class="settings-save" onclick="window.toggleSettings()">Save Settings</button>
            <div class="thanks-text" onclick="window.open('https://youtube.com/@janoi.agar1?si=uKX3RKWFuEMtcxxF')">Made with love by Storm</div>`;
        document.body.appendChild(modal);
    }

    function saveSettings() {
        const nameInput = document.getElementById('botName');
        const amountInput = document.getElementById('botAmount');
        const splitKeyInput = document.getElementById('splitKey');
        const feedKeyInput = document.getElementById('feedKey');
        const modeKeyInput = document.getElementById('modeKey');
        const vShieldKeyInput = document.getElementById('vShieldKey');

        if (nameInput && amountInput && splitKeyInput && feedKeyInput && modeKeyInput && vShieldKeyInput) {
            const botName = nameInput.value.trim() || 'Janoi-Bots';
            let botAmount = parseInt(amountInput.value);
            if (isNaN(botAmount) || botAmount < 1) botAmount = 1;
            if (botAmount > 200) botAmount = 200;

            const splitKey = splitKeyInput.value.toUpperCase() || ' ';
            const feedKey = feedKeyInput.value.toUpperCase() || ' ';
            const modeKey = modeKeyInput.value.toUpperCase() || ' ';
            const vShieldKey = vShieldKeyInput.value.toUpperCase() || ' ';

            localStorage.setItem('Janoi-bot-name', botName);
            localStorage.setItem('botAmount', botAmount);

            botConfig.botCount = botAmount;
            botConfig.keybinds.splitKey = splitKey;
            botConfig.keybinds.feedKey = feedKey;
            botConfig.keybinds.modeKey = modeKey;
            botConfig.keybinds.vShieldKey = vShieldKey;

            Bots.forEach(bot => bot.name = botName);
            const botCountEl = document.querySelector(".janoi-botCount");
            if (botCountEl && !botConfig.startedBots) {
                botCountEl.textContent = `0/${botConfig.botCount}`;
            }
            updateBotCount();
        }
    }

    const initWebSocket = () => {
        const allowedUrls = ["delt.io", "ixagar", "glitch", "socket.io", "firebase", "agartool.io", "herokuapp", "localhost"];
        const isAllowed = url => allowedUrls.some(domain => url.includes(domain));
        if (!WebSocket.prototype._originalSend) {
            WebSocket.prototype._originalSend = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
                if (!isAllowed(this.url)) {
                    botConfig.agarServer = this.url;
                }
                WebSocket.prototype._originalSend.call(this, data);
            };
        }
    };

    const initInterval = () => {
        setInterval(() => {
            if (window.app?.unitManager?.activeUnit?.cursor) {
                botConfig.cords.x = window.app.unitManager.activeUnit.cursor.x;
                botConfig.cords.y = window.app.unitManager.activeUnit.cursor.y;
            } else if (window.app?.mouse) {
                botConfig.cords.x = window.app.mouse.x;
                botConfig.cords.y = window.app.mouse.y;
            }
        }, 50);
    };

    if (/agar.io/.test(location.hostname)) {
        const checkApp = setInterval(() => {
            if (window.app) {
                clearInterval(checkApp);
                injectScript();
                window.startBots = startBots;
            }
        }, 100);
    }
})();
