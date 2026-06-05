'use strict';

const { createCanvas } = require('@napi-rs/canvas');
const fs   = require('fs');
const path = require('path');

const SIZE = 512;
const R    = 80;

const canvas = createCanvas(SIZE, SIZE);
const ctx    = canvas.getContext('2d');

// Fundo escuro com cantos arredondados
ctx.fillStyle = '#0f1117';
ctx.beginPath();
ctx.moveTo(R, 0);
ctx.lineTo(SIZE - R, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, R);
ctx.lineTo(SIZE, SIZE - R);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - R, SIZE);
ctx.lineTo(R, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - R);
ctx.lineTo(0, R);
ctx.quadraticCurveTo(0, 0, R, 0);
ctx.closePath();
ctx.fill();

// Tilde coral
ctx.strokeStyle = '#FF5C39';
ctx.lineWidth   = 16;
ctx.lineCap     = 'round';
ctx.beginPath();
ctx.moveTo(90,  155);
ctx.bezierCurveTo(145, 95,  210, 95,  256, 150);
ctx.bezierCurveTo(302, 205, 367, 205, 422, 145);
ctx.stroke();

// "DELÍRIO" em verde
ctx.fillStyle    = '#00B373';
ctx.font         = 'bold 96px Arial, sans-serif';
ctx.textAlign    = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('DELÍRIO', SIZE / 2, 310);

// "MANAGER" em branco
ctx.fillStyle = 'rgba(255,255,255,0.75)';
ctx.font      = '48px Arial, sans-serif';
ctx.fillText('MANAGER', SIZE / 2, 405);

// Salva PNG
const outPath = path.join(__dirname, '..', 'electron', 'icon.png');
fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
console.log('Ícone gerado:', outPath);
