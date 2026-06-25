// =====================================================================
// Edge Function: kobo-webhook
// Recibe los webhooks (REST Services) de los 3 formularios de KoboToolbox
// y los inserta/actualiza en las tablas correspondientes de Supabase.
//
// Formularios (identificados por _xform_id_string del payload de Kobo):
//   - registro_organizaciones_cbs_v1   -> organizaciones
//   - registro_asociados_cbs_v1        -> personas + membresias
//   - lista_chequeo_bpa_platano_ica_cbs -> certificaciones_ica + criterios_cumplimiento
//
// Variables de entorno requeridas (configurar como secrets, Tarea 6):
//   SUPABASE_URL              - se inyecta automaticamente en Edge Functions
//   SUPABASE_SERVICE_ROLE_KEY - se inyecta automaticamente en Edge Functions
//   WEBHOOK_SECRET            - valor que tambien se configura en el header
//                               personalizado del REST Service de Kobo
//   KOBO_API_TOKEN            - token de KoboToolbox (Account Settings > Security)
//                               necesario para descargar fotos adjuntas
// =====================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const KOBO_API_TOKEN = Deno.env.get("KOBO_API_TOKEN") ?? "";

const FORM_IDS = {
  ORGANIZACIONES: "registro_organizaciones_cbs_v1",
  ASOCIADOS: "registro_asociados_cbs_v1",
  CERTIFICACION: "lista_chequeo_bpa_platano_ica_cbs",
};

// ---------------------------------------------------------------------
// Catalogos de codigo -> etiqueta (deben coincidir con las hojas
// 'choices' de cada XLSForm). Si agregas opciones nuevas en Kobo,
// agregalas tambien aqui.
// ---------------------------------------------------------------------
const DEPARTAMENTOS: Record<string, string> = {
  valle_cauca: "Valle del Cauca", meta: "Meta", narino: "Nariño",
  caqueta: "Caquetá", cauca: "Cauca", otro: "Otro",
};

const MUNICIPIOS: Record<string, string> = {
  dagua: "Dagua", el_dovio: "El Dovio", bolivar: "Bolívar", cartago: "Cartago",
  ulloa: "Ulloa", alcala: "Alcalá", ansermanuevo: "Ansermanuevo", obando: "Obando",
  la_victoria: "La Victoria", el_aguila: "El Águila", versalles: "Versalles",
  villavicencio: "Villavicencio", puerto_lopez: "Puerto López", puerto_gaitan: "Puerto Gaitán",
  mapiripan: "Mapiripán", san_martin: "San Martín", tumaco: "Tumaco",
  puerto_rico: "Puerto Rico", la_montanita: "La Montañita",
  cartagena_chaira: "Cartagena del Chairá", solano: "Solano", popayan: "Popayán",
  otro: "Otro",
};

const TIPO_ORGANIZACION: Record<string, string> = {
  asociacion: "Asociación", cooperativa: "Cooperativa", corporacion: "Corporación",
  fundacion: "Fundación", jac: "Junta de Acción Comunal",
  empresa_comunitaria: "Empresa Comunitaria", otro: "Otro",
};

// ---------------------------------------------------------------------
// Los 47 criterios de la Lista de Chequeo BPA (generados desde la misma
// fuente que el XLSForm de Encuesta 3 - no editar a mano sin actualizar
// tambien el formulario)
// ---------------------------------------------------------------------
const CRITERIOS: { codigo: string; grupo: string; campo: string; seccion: string; criticidad: string; descripcion: string }[] = [
  { codigo: "1.1", grupo: "sec1", campo: "item_1_1", seccion: "1. Áreas e instalaciones", criticidad: "F", descripcion: "Baño/unidad sanitaria para trabajadores" },
  { codigo: "1.2", grupo: "sec1", campo: "item_1_2", seccion: "1. Áreas e instalaciones", criticidad: "F", descripcion: "Punto de lavado de manos con agua y jabón" },
  { codigo: "1.3", grupo: "sec1", campo: "item_1_3", seccion: "1. Áreas e instalaciones", criticidad: "My", descripcion: "Almacén de insumos separado, bajo llave y señalizado" },
  { codigo: "1.4", grupo: "sec1", campo: "item_1_4", seccion: "1. Áreas e instalaciones", criticidad: "My", descripcion: "Área exclusiva para preparación de mezclas" },
  { codigo: "1.5", grupo: "sec1", campo: "item_1_5", seccion: "1. Áreas e instalaciones", criticidad: "My", descripcion: "Área de acopio/empaque limpia, techada y con piso duro" },
  { codigo: "1.6", grupo: "sec1", campo: "item_1_6", seccion: "1. Áreas e instalaciones", criticidad: "Mn", descripcion: "Señalización de riesgos visible" },
  { codigo: "2.1", grupo: "sec2", campo: "item_2_1", seccion: "2. Equipos y herramientas", criticidad: "My", descripcion: "Equipos de aplicación calibrados y con registro" },
  { codigo: "2.2", grupo: "sec2", campo: "item_2_2", seccion: "2. Equipos y herramientas", criticidad: "My", descripcion: "Herramientas de cosecha limpias y desinfectadas" },
  { codigo: "2.3", grupo: "sec2", campo: "item_2_3", seccion: "2. Equipos y herramientas", criticidad: "Mn", descripcion: "Registro de mantenimiento de equipos" },
  { codigo: "2.4", grupo: "sec2", campo: "item_2_4", seccion: "2. Equipos y herramientas", criticidad: "F", descripcion: "EPP disponibles y en buen estado" },
  { codigo: "2.5", grupo: "sec2", campo: "item_2_5", seccion: "2. Equipos y herramientas", criticidad: "F", descripcion: "Trabajadores usan EPP completo durante aplicaciones" },
  { codigo: "3.1", grupo: "sec3", campo: "item_3_1", seccion: "3. Material de propagación", criticidad: "My", descripcion: "Material de siembra libre de plagas y enfermedades" },
  { codigo: "3.2", grupo: "sec3", campo: "item_3_2", seccion: "3. Material de propagación", criticidad: "My", descripcion: "Tratamiento fitosanitario al material antes de siembra" },
  { codigo: "3.3", grupo: "sec3", campo: "item_3_3", seccion: "3. Material de propagación", criticidad: "My", descripcion: "Sanidad garantizada si el material es del predio" },
  { codigo: "3.4", grupo: "sec3", campo: "item_3_4", seccion: "3. Material de propagación", criticidad: "Mn", descripcion: "Material genéticamente modificado autorizado por ICA" },
  { codigo: "4.1", grupo: "sec4", campo: "item_4_1", seccion: "4. Agua", criticidad: "F", descripcion: "Análisis microbiológico de agua vigente (≤ 1 año)" },
  { codigo: "4.2", grupo: "sec4", campo: "item_4_2", seccion: "4. Agua", criticidad: "My", descripcion: "Permiso de uso de aguas o radicado de solicitud" },
  { codigo: "4.3", grupo: "sec4", campo: "item_4_3", seccion: "4. Agua", criticidad: "My", descripcion: "Agua de postcosecha de fuente limpia y controlada" },
  { codigo: "4.4", grupo: "sec4", campo: "item_4_4", seccion: "4. Agua", criticidad: "Mn", descripcion: "Registros del uso del agua en el cultivo" },
  { codigo: "5.1", grupo: "sec5", campo: "item_5_1", seccion: "5. Nutrición de plantas y fertilización", criticidad: "My", descripcion: "Plan de fertilización basado en análisis de suelo" },
  { codigo: "5.2", grupo: "sec5", campo: "item_5_2", seccion: "5. Nutrición de plantas y fertilización", criticidad: "My", descripcion: "Análisis de suelo vigente" },
  { codigo: "5.3", grupo: "sec5", campo: "item_5_3", seccion: "5. Nutrición de plantas y fertilización", criticidad: "My", descripcion: "Fertilizantes con registro ICA, almacenes autorizados" },
  { codigo: "5.4", grupo: "sec5", campo: "item_5_4", seccion: "5. Nutrición de plantas y fertilización", criticidad: "My", descripcion: "Aplicaciones de fertilizantes registradas" },
  { codigo: "5.5", grupo: "sec5", campo: "item_5_5", seccion: "5. Nutrición de plantas y fertilización", criticidad: "Mn", descripcion: "Compostaje técnico para abonos orgánicos propios" },
  { codigo: "6.1", grupo: "sec6", campo: "item_6_1", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "My", descripcion: "Plan MIPE documentado" },
  { codigo: "6.2", grupo: "sec6", campo: "item_6_2", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "F", descripcion: "Plaguicidas registrados ante ICA, categoría toxicológica permitida" },
  { codigo: "6.3", grupo: "sec6", campo: "item_6_3", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "F", descripcion: "Períodos de carencia de plaguicidas respetados" },
  { codigo: "6.4", grupo: "sec6", campo: "item_6_4", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "My", descripcion: "Registros de aplicación (producto, dosis, fecha, operario, lote)" },
  { codigo: "6.5", grupo: "sec6", campo: "item_6_5", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "My", descripcion: "Plaguicidas en envases originales, etiquetados, bajo llave" },
  { codigo: "6.6", grupo: "sec6", campo: "item_6_6", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "My", descripcion: "Triple lavado y gestión adecuada de envases vacíos" },
  { codigo: "6.7", grupo: "sec6", campo: "item_6_7", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "My", descripcion: "Monitoreo periódico de plagas" },
  { codigo: "6.8", grupo: "sec6", campo: "item_6_8", seccion: "6. Manejo integrado de plagas y enfermedades (MIPE)", criticidad: "Mn", descripcion: "Priorización de control biológico y cultural" },
  { codigo: "7.1", grupo: "sec7", campo: "item_7_1", seccion: "7. Cosecha y postcosecha", criticidad: "My", descripcion: "Personal de cosecha capacitado en higiene y manejo" },
  { codigo: "7.2", grupo: "sec7", campo: "item_7_2", seccion: "7. Cosecha y postcosecha", criticidad: "My", descripcion: "Recipientes y herramientas de cosecha limpios y desinfectados" },
  { codigo: "7.3", grupo: "sec7", campo: "item_7_3", seccion: "7. Cosecha y postcosecha", criticidad: "My", descripcion: "Se evita contacto del racimo con el suelo" },
  { codigo: "7.4", grupo: "sec7", campo: "item_7_4", seccion: "7. Cosecha y postcosecha", criticidad: "Mn", descripcion: "Transporte en condiciones higiénicas" },
  { codigo: "7.5", grupo: "sec7", campo: "item_7_5", seccion: "7. Cosecha y postcosecha", criticidad: "My", descripcion: "Lotes cosechados registrados (fecha, cantidad, destino)" },
  { codigo: "8.1", grupo: "sec8", campo: "item_8_1", seccion: "8. Salud, seguridad y bienestar del trabajador", criticidad: "F", descripcion: "Trabajadores capacitados en BPA, higiene y seguridad" },
  { codigo: "8.2", grupo: "sec8", campo: "item_8_2", seccion: "8. Salud, seguridad y bienestar del trabajador", criticidad: "My", descripcion: "Registro de capacitaciones" },
  { codigo: "8.3", grupo: "sec8", campo: "item_8_3", seccion: "8. Salud, seguridad y bienestar del trabajador", criticidad: "Mn", descripcion: "Botiquín de primeros auxilios y protocolo de emergencia" },
  { codigo: "8.4", grupo: "sec8", campo: "item_8_4", seccion: "8. Salud, seguridad y bienestar del trabajador", criticidad: "My", descripcion: "Prohibición de fumar/comer/beber en áreas de cultivo" },
  { codigo: "9.1", grupo: "sec9", campo: "item_9_1", seccion: "9. Gestión ambiental", criticidad: "Mn", descripcion: "Plan de manejo de residuos" },
  { codigo: "9.2", grupo: "sec9", campo: "item_9_2", seccion: "9. Gestión ambiental", criticidad: "My", descripcion: "Protección de fuentes de agua y rondas hídricas" },
  { codigo: "9.3", grupo: "sec9", campo: "item_9_3", seccion: "9. Gestión ambiental", criticidad: "Mn", descripcion: "Prácticas de conservación de suelos" },
  { codigo: "10.1", grupo: "sec10", campo: "item_10_1", seccion: "10. Trazabilidad y registros", criticidad: "My", descripcion: "Plan de trazabilidad (lote → comprador)" },
  { codigo: "10.2", grupo: "sec10", campo: "item_10_2", seccion: "10. Trazabilidad y registros", criticidad: "My", descripcion: "Registros del predio actualizados y disponibles" },
  { codigo: "10.3", grupo: "sec10", campo: "item_10_3", seccion: "10. Trazabilidad y registros", criticidad: "Mn", descripcion: "Registros conservados al menos 2 años" },
];

// ---------------------------------------------------------------------
// Utilidades de transformacion (puras - sin I/O, ver test_logica.mjs)
// ---------------------------------------------------------------------

/** Convierte un geopoint de Kobo "lat lon alt acc" en sus componentes */
function parseGeopoint(value: unknown): { lat: number; lon: number; alt: number | null; acc: number | null } | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return { lat: parts[0], lon: parts[1], alt: parts[2] ?? null, acc: parts[3] ?? null };
}

/** Construye el literal geography(Point) en formato WKT para Postgres/PostGIS */
function geopointToWKT(geo: { lat: number; lon: number } | null): string | null {
  if (!geo) return null;
  return `SRID=4326;POINT(${geo.lon} ${geo.lat})`;
}

/** Si el codigo seleccionado es 'otro' y hay texto libre, usa el texto libre */
function resolveOtro(codigo: unknown, textoOtro: unknown): string | null {
  if (codigo === null || codigo === undefined || codigo === "") return null;
  if (codigo === "otro" && typeof textoOtro === "string" && textoOtro.trim() !== "") {
    return textoOtro.trim();
  }
  return String(codigo);
}

/** select_multiple de Kobo llega como string separado por espacios */
function parseSelectMultiple(value: unknown, otroMap?: Record<string, string>): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.trim().split(/\s+/).map((code) => {
    if (code === "otro" && otroMap?.otro) return otroMap.otro;
    return code;
  });
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function toBoolOrNull(value: unknown): boolean | null {
  if (value === "si") return true;
  if (value === "no") return false;
  return null;
}

// ---------------------------------------------------------------------
// Manejo de fotos: descarga desde Kobo (autenticado) y sube a Storage
// ---------------------------------------------------------------------
async function migrarFoto(
  supabase: SupabaseClient,
  attachments: any[],
  filename: unknown,
  rutaDestino: string,
): Promise<string | null> {
  if (typeof filename !== "string" || filename.trim() === "") return null;
  const attachment = attachments?.find((a) => a.filename?.endsWith(filename));
  if (!attachment?.download_url) {
    console.error("No se encontro el adjunto para", filename);
    return null;
  }

  const resp = await fetch(attachment.download_url, {
    headers: { Authorization: `Token ${KOBO_API_TOKEN}` },
  });
  if (!resp.ok) {
    console.error("Error descargando adjunto de Kobo:", resp.status, await resp.text());
    return null;
  }
  const blob = await resp.blob();
  const contentType = attachment.mimetype || "image/jpeg";

  const { error } = await supabase.storage
    .from("evidencias-certificacion")
    .upload(rutaDestino, blob, { contentType, upsert: true });

  if (error) {
    console.error("Error subiendo a Storage:", error.message);
    return null;
  }
  // Se guarda la RUTA (no una URL firmada, que caduca). El panel genera
  // la URL firmada al momento de mostrarla con createSignedUrl().
  return rutaDestino;
}

// ---------------------------------------------------------------------
// Handler: Encuesta 1 - Organizaciones
// ---------------------------------------------------------------------
async function handleOrganizaciones(supabase: SupabaseClient, body: any) {
  const geo = parseGeopoint(body["gps_sede"]);
  const municipio = body["municipio"] === "otro"
    ? (body["municipio_otro"] || "Otro")
    : (MUNICIPIOS[body["municipio"]] ?? body["municipio"]);

  const registro = {
    nombre: body["nombre"],
    sigla: body["sigla"] || null,
    nit: body["nit"],
    tipo_organizacion: TIPO_ORGANIZACION[body["tipo_organizacion"]] ?? body["tipo_organizacion"],
    anio_constitucion: toNumberOrNull(body["anio_constitucion"]),
    departamento: DEPARTAMENTOS[body["departamento"]] ?? body["departamento"],
    municipio,
    veredas_presencia: body["veredas_presencia"] || null,
    direccion: body["direccion"] || null,
    representante_legal: body["representante_legal"],
    telefono: body["telefono"],
    correo_electronico: body["correo_electronico"] || null,
    gps_sede: body["gps_sede"] || null,
    gps_sede_geom: geopointToWKT(geo),
    pendiente_georeferenciacion: !geo || !body["direccion"],
    fecha_actualizacion: new Date().toISOString(),
  };

  const codigo = body["codigo_organizacion"];
  const { data: existing } = await supabase
    .from("organizaciones").select("id").eq("codigo_organizacion", codigo).maybeSingle();

  if (existing) {
    const { error } = await supabase.from("organizaciones").update(registro).eq("id", existing.id);
    if (error) throw error;
    return { accion: "actualizada", codigo_organizacion: codigo };
  } else {
    const { error } = await supabase.from("organizaciones")
      .insert({ ...registro, codigo_organizacion: codigo });
    if (error) throw error;
    return { accion: "creada", codigo_organizacion: codigo };
  }
}

// ---------------------------------------------------------------------
// Handler: Encuesta 2 - Asociados (personas + membresias)
// ---------------------------------------------------------------------
async function handleAsociados(supabase: SupabaseClient, body: any) {
  const numeroDocumento = body["numero_documento"];
  const codigoOrganizacion = body["codigo_organizacion"];

  const { data: org, error: orgErr } = await supabase
    .from("organizaciones").select("id").eq("codigo_organizacion", codigoOrganizacion).single();
  if (orgErr || !org) {
    throw new Error(`Organización ${codigoOrganizacion} no encontrada. Registrela primero con la Encuesta 1.`);
  }

  // --- 1. Upsert de la persona por numero_documento ---
  const datosPersona = {
    tipo_documento: body["tipo_documento"],
    nombre_completo: body["nombre_completo"],
    telefono: body["telefono"],
    num_personas_familia: toNumberOrNull(body["num_personas_familia"]),
    fecha_actualizacion: new Date().toISOString(),
  };

  const { data: personaExistente } = await supabase
    .from("personas").select("id").eq("numero_documento", numeroDocumento).maybeSingle();

  let personaId: string;
  if (personaExistente) {
    personaId = personaExistente.id;
    const { error } = await supabase.from("personas").update(datosPersona).eq("id", personaId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from("personas")
      .insert({ ...datosPersona, numero_documento: numeroDocumento })
      .select("id").single();
    if (error) throw error;
    personaId = data.id;
  }

  // --- 2. Upsert de la membresia por (persona_id, organizacion_id) ---
  const geo = parseGeopoint(body["gps_predio"]);
  const destinoVenta = parseSelectMultiple(body["destino_venta"], { otro: body["destino_venta_otro"] });

  const datosMembresia = {
    nombre_predio: body["nombre_predio"] || null,
    gps_predio: body["gps_predio"] || null,
    gps_predio_geom: geopointToWKT(geo),
    cultivo_principal: resolveOtro(body["cultivo_principal"], body["cultivo_principal_otro"]),
    hectareas_cultivo_principal: toNumberOrNull(body["hectareas_cultivo_principal"]),
    produccion_cultivo_principal: toNumberOrNull(body["produccion_cultivo_principal"]),
    cultivo_secundario: resolveOtro(body["cultivo_secundario"], body["cultivo_secundario_otro"]),
    hectareas_cultivo_secundario: toNumberOrNull(body["hectareas_cultivo_secundario"]),
    produccion_cultivo_secundario: toNumberOrNull(body["produccion_cultivo_secundario"]),
    cultivo_terciario: resolveOtro(body["cultivo_terciario"], body["cultivo_terciario_otro"]),
    hectareas_cultivo_terciario: toNumberOrNull(body["hectareas_cultivo_terciario"]),
    produccion_cultivo_terciario: toNumberOrNull(body["produccion_cultivo_terciario"]),
    hectareas_sembradas: toNumberOrNull(body["hectareas_sembradas"]),
    produccion_anual: toNumberOrNull(body["produccion_anual"]),
    destino_venta: destinoVenta,
    fecha_actualizacion: new Date().toISOString(),
  };

  const { data: membresiaExistente } = await supabase
    .from("membresias").select("id")
    .eq("persona_id", personaId).eq("organizacion_id", org.id).maybeSingle();

  if (membresiaExistente) {
    const { error } = await supabase.from("membresias").update(datosMembresia).eq("id", membresiaExistente.id);
    if (error) throw error;
    return { accion: "membresia_actualizada", codigo_asociado: body["codigo_asociado"] };
  } else {
    const { error } = await supabase.from("membresias").insert({
      ...datosMembresia,
      codigo_asociado: body["codigo_asociado"],
      persona_id: personaId,
      organizacion_id: org.id,
    });
    if (error) {
      if (error.code === "23505") {
        console.error("Conflicto de unicidad al crear membresia:", error.message);
        throw new Error("DUPLICADO: " + error.message);
      }
      throw error;
    }
    return { accion: "membresia_creada", codigo_asociado: body["codigo_asociado"] };
  }
}

// ---------------------------------------------------------------------
// Handler: Encuesta 3 - Certificacion ICA
// ---------------------------------------------------------------------
async function handleCertificacion(supabase: SupabaseClient, body: any) {
  const codigoAsociado = body["codigo_asociado"];

  const { data: membresia, error: memErr } = await supabase
    .from("membresias").select("id, organizacion_id")
    .eq("codigo_asociado", codigoAsociado).single();
  if (memErr || !membresia) {
    throw new Error(`Membresía ${codigoAsociado} no encontrada. Registre primero al asociado en la Encuesta 2.`);
  }

  const geo = parseGeopoint(body["gps_predio_visita"]);
  const fechaVisita = body["fecha_visita"] || new Date().toISOString().slice(0, 10);
  const codigoCertificacion = `CERT-${codigoAsociado}-${fechaVisita.replaceAll("-", "")}`;

  // --- observaciones por seccion (sec1..sec10) ---
  const observacionesPorSeccion: Record<string, string> = {};
  for (let n = 1; n <= 10; n++) {
    const v = body[`sec${n}/observaciones_sec${n}`];
    if (v) observacionesPorSeccion[`seccion_${n}`] = v;
  }

  // --- fotos de evidencia (sec1 y sec6) ---
  const attachments = body["_attachments"] ?? [];
  const fotos: string[] = [];
  const fotoSec1 = await migrarFoto(
    supabase, attachments, body["sec1/foto_sec1"],
    `${body["codigo_organizacion"]}/${codigoAsociado}/${fechaVisita}_instalaciones.jpg`,
  );
  if (fotoSec1) fotos.push(fotoSec1);
  const fotoSec6 = await migrarFoto(
    supabase, attachments, body["sec6/foto_sec6"],
    `${body["codigo_organizacion"]}/${codigoAsociado}/${fechaVisita}_plaguicidas.jpg`,
  );
  if (fotoSec6) fotos.push(fotoSec6);

  const registro = {
    membresia_id: membresia.id,
    organizacion_id: membresia.organizacion_id,
    nombre_productor: body["nombre_productor"] || null,
    nombre_predio: body["nombre_finca"] || null,
    municipio_vereda: body["municipio_vereda"] || null,
    gps_predio: body["gps_predio_visita"] || null,
    gps_predio_geom: geopointToWKT(geo),
    especie_cultivada: body["especie_cultivada"],
    area_total_predio: toNumberOrNull(body["area_total_predio"]),
    area_en_produccion: toNumberOrNull(body["area_en_produccion"]),
    tiene_asistencia_tecnica: toBoolOrNull(body["tiene_asistencia_tecnica"]),
    tipo_asistencia_tecnica: body["tipo_asistencia_tecnica"] || null,
    fuente_abastecimiento_agua: body["sec4/fuente_abastecimiento_agua"] || null,
    fecha_visita_tecnica: fechaVisita,
    fundamentales_cumplidos: toNumberOrNull(body["sec11/calc_f_cumple"]),
    fundamentales_aplicables: toNumberOrNull(body["sec11/calc_f_aplicables"]),
    mayores_cumplidos: toNumberOrNull(body["sec11/calc_my_cumple"]),
    mayores_aplicables: toNumberOrNull(body["sec11/calc_my_aplicables"]),
    menores_cumplidos: toNumberOrNull(body["sec11/calc_mn_cumple"]),
    menores_aplicables: toNumberOrNull(body["sec11/calc_mn_aplicables"]),
    sugerencia_automatica: body["sec11/calc_sugerencia"] || null,
    concepto_tecnico: body["sec11/concepto_tecnico"],
    observaciones_generales: body["sec11/observaciones_generales"] || null,
    observaciones_por_seccion: observacionesPorSeccion,
    tecnico_responsable: body["sec11/nombre_firma_auditor"],
    fotos_evidencia: fotos,
  };

  const { data: certInsertada, error: certErr } = await supabase
    .from("certificaciones_ica")
    .insert({ ...registro, codigo_certificacion: codigoCertificacion })
    .select("id").single();
  if (certErr) throw certErr;

  // --- 47 criterios de cumplimiento ---
  const filasCriterios = CRITERIOS.map((c) => ({
    certificacion_id: certInsertada.id,
    codigo_criterio: c.codigo,
    seccion: c.seccion,
    criticidad: c.criticidad,
    descripcion: c.descripcion,
    respuesta: body[`${c.grupo}/${c.campo}`] ?? "na",
  }));

  const { error: critErr } = await supabase.from("criterios_cumplimiento").insert(filasCriterios);
  if (critErr) throw critErr;

  return { accion: "certificacion_creada", codigo_certificacion: codigoCertificacion };
}

// ---------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    console.error("Webhook rechazado: secreto invalido o ausente");
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("JSON invalido", { status: 400 });
  }

  const formId = body["_xform_id_string"];

  try {
    let resultado;
    switch (formId) {
      case FORM_IDS.ORGANIZACIONES:
        resultado = await handleOrganizaciones(supabase, body);
        break;
      case FORM_IDS.ASOCIADOS:
        resultado = await handleAsociados(supabase, body);
        break;
      case FORM_IDS.CERTIFICACION:
        resultado = await handleCertificacion(supabase, body);
        break;
      default:
        console.error("Formulario no reconocido:", formId);
        return new Response(`Formulario no reconocido: ${formId}`, { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, ...resultado }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error procesando webhook:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
