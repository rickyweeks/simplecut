import { LUT_SIZE } from '@simplecut/core';

/**
 * Applies a clip's color grade in the preview: the grade is baked into a 3D LUT by the core
 * (the same table the export writes as a .cube for FFmpeg's lut3d), uploaded as a 3D texture
 * and sampled with hardware trilinear filtering, which is what lut3d's trilinear mode does.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_src;
uniform sampler3D u_lut;
uniform float u_size;
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 c = clamp(texture(u_src, v_uv).rgb, 0.0, 1.0);
  // Sample texel centers: input 0 and 1 hit the first and last table entries exactly.
  vec3 coord = (c * (u_size - 1.0) + 0.5) / u_size;
  o = vec4(texture(u_lut, coord).rgb, 1.0);
}`;

export class ColorProcessor {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private srcTex: WebGLTexture | null = null;
  private luts = new Map<string, WebGLTexture>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (this.gl) this.init(this.gl);
  }

  get available(): boolean {
    return !!this.gl && !!this.program;
  }

  private init(gl: WebGL2RenderingContext): void {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.program = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(p, 'u_src'), 0);
    gl.uniform1i(gl.getUniformLocation(p, 'u_lut'), 1);
    gl.uniform1f(gl.getUniformLocation(p, 'u_size'), LUT_SIZE);
    this.srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private lutTexture(key: string, bake: () => Float32Array): WebGLTexture {
    let tex = this.luts.get(key);
    if (tex) return tex;
    const gl = this.gl!;
    if (this.luts.size > 32) {
      for (const t of this.luts.values()) gl.deleteTexture(t);
      this.luts.clear();
    }
    tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGB, gl.FLOAT, bake());
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.luts.set(key, tex);
    return tex;
  }

  /**
   * Grades one picture into the processor's canvas (w x h) and returns it, ready to be drawn.
   * Draw it before grading the next picture.
   */
  process(src: TexImageSource, w: number, h: number, key: string, bake: () => Float32Array): HTMLCanvasElement | null {
    const gl = this.gl;
    if (!gl || !this.program) return null;
    const cw = Math.max(2, Math.round(w));
    const ch = Math.max(2, Math.round(h));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    const lut = this.lutTexture(key, bake);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      return null;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}
