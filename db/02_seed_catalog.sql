-- =====================================================================
-- Afirmative Pill · 02_seed_catalog.sql
-- Carga del dataset oficial del taller: 50 medicamentos reales.
-- Generado automaticamente desde
--   'Afirmative Pill - Dataset de Medicamentos (Supabase).xlsx'
--
-- El dataset original es una tabla plana de 12 columnas. Aqui se normaliza en
-- tres tablas (categories, manufacturers, medications) para que el catalogo
-- tenga relaciones reales y el problema N+1 sea genuino y demostrable.
-- Idempotente: se puede ejecutar varias veces sin duplicar datos.
-- =====================================================================

BEGIN;

-- --------- 14 categorias terapeuticas ---------
INSERT INTO categories (id, slug, name) VALUES
  (1, 'ANALGESICOS', 'Analgésicos'),
  (2, 'ANTIBIOTICOS', 'Antibióticos'),
  (3, 'ANTIHISTAMINICOS', 'Antihistamínicos'),
  (4, 'ANTIINFLAMATORIOS', 'Antiinflamatorios'),
  (5, 'ANTIMICOTICOS', 'Antimicóticos'),
  (6, 'ANTIVIRALES', 'Antivirales'),
  (7, 'CARDIOVASCULAR', 'Cardiovascular'),
  (8, 'CORTICOSTEROIDES', 'Corticosteroides'),
  (9, 'DERMATOLOGICO', 'Dermatológico'),
  (10, 'ENDOCRINOLOGIA', 'Endocrinología'),
  (11, 'GASTROINTESTINAL', 'Gastrointestinal'),
  (12, 'PEDIATRIA_SUEROS', 'Pediatría / Sueros'),
  (13, 'PSIQUIATRIA_NEURO', 'Psiquiatría / Neuro'),
  (14, 'RESPIRATORIO', 'Respiratorio')
ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name;
SELECT setval(pg_get_serial_sequence('categories','id'), (SELECT MAX(id) FROM categories));

-- --------- 16 laboratorios fabricantes ---------
INSERT INTO manufacturers (id, slug, name) VALUES
  (1, 'ABBOTT', 'Abbott'),
  (2, 'ASTRAZENECA', 'AstraZeneca'),
  (3, 'BAYER', 'Bayer'),
  (4, 'BOEHRINGER_INGELHEIM', 'Boehringer Ingelheim'),
  (5, 'GENFAR', 'Genfar'),
  (6, 'GLAXOSMITHKLINE', 'GlaxoSmithKline'),
  (7, 'GRUNENTHAL', 'Grunenthal'),
  (8, 'JANSSEN', 'Janssen'),
  (9, 'LABORATORIOS_MK', 'Laboratorios MK'),
  (10, 'LAFRANCOL', 'Lafrancol'),
  (11, 'MERCK', 'Merck'),
  (12, 'PFIZER', 'Pfizer'),
  (13, 'ROCHE', 'Roche'),
  (14, 'SANDOZ', 'Sandoz'),
  (15, 'SANOFI', 'Sanofi'),
  (16, 'TECNOQUIMICAS', 'Tecnoquímicas')
ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name;
SELECT setval(pg_get_serial_sequence('manufacturers','id'), (SELECT MAX(id) FROM manufacturers));

-- --------- 50 medicamentos ---------
INSERT INTO medications (
  id, sku, name, active_ingredient, category_id, manufacturer_id,
  dosage, presentation, price_cop, stock, requires_prescription, description
) VALUES
  (1, 'MED-001', 'Acetaminofén Forte', 'Paracetamol', 1, 9, '500 mg', 'Caja x 20 tabletas', 9500.00, 120, FALSE, 'Alivio del dolor de cabeza y cuadros febriles leves a moderados.'),
  (2, 'MED-002', 'Ibuprofeno Max', 'Ibuprofeno', 4, 5, '800 mg', 'Caja x 30 tabletas', 18200.00, 85, FALSE, 'Antiinflamatorio no esteroideo para dolores articulares y musculares.'),
  (3, 'MED-003', 'Amoxicilina Clavulanato', 'Amoxicilina + Ácido Clavulánico', 2, 14, '875/125 mg', 'Caja x 14 tabletas', 46000.00, 40, TRUE, 'Antibiótico de amplio espectro para infecciones respiratorias bacterianas.'),
  (4, 'MED-004', 'Loratadina Antiallerg', 'Loratadina', 3, 16, '10 mg', 'Caja x 10 tabletas', 8900.00, 150, FALSE, 'Tratamiento sintomático de rinitis alérgica y urticaria crónica.'),
  (5, 'MED-005', 'Omeprazol GastroProtect', 'Omeprazol', 11, 10, '20 mg', 'Caja x 28 cápsulas', 14500.00, 110, FALSE, 'Inhibidor de la bomba de protones para reflujo gástrico y úlceras.'),
  (6, 'MED-006', 'Losartán Potásico', 'Losartán', 7, 5, '50 mg', 'Caja x 30 tabletas', 16800.00, 95, TRUE, 'Antihipertensivo antagonista de los receptores de angiotensina II.'),
  (7, 'MED-007', 'Metformina Clorhidrato', 'Metformina', 10, 11, '850 mg', 'Caja x 30 tabletas', 21000.00, 75, TRUE, 'Hipoglucemiante oral para control de glucemia en diabetes tipo 2.'),
  (8, 'MED-008', 'Atorvastatina Lipid', 'Atorvastatina', 7, 12, '20 mg', 'Caja x 30 tabletas', 32500.00, 60, TRUE, 'Regulador lipídico para reducir colesterol LDL y triglicéridos.'),
  (9, 'MED-009', 'Cetirizina Dihidrocloruro', 'Cetirizina', 3, 3, '10 mg', 'Caja x 10 tabletas', 11200.00, 130, FALSE, 'Antihistamínico de segunda generación para cuadros alérgicos agudos.'),
  (10, 'MED-010', 'Azitromicina Unidosis', 'Azitromicina', 2, 5, '500 mg', 'Caja x 3 tabletas', 28900.00, 50, TRUE, 'Macrólido indicado en infecciones del tracto respiratorio y piel.'),
  (11, 'MED-011', 'Esomeprazol Dual', 'Esomeprazol', 11, 2, '40 mg', 'Caja x 14 cápsulas', 39000.00, 45, FALSE, 'Tratamiento avanzado de esofagitis erosiva por reflujo gastroesofágico.'),
  (12, 'MED-012', 'Clonazepam Sedafast', 'Clonazepam', 13, 13, '2 mg', 'Caja x 30 tabletas', 27400.00, 25, TRUE, 'Benzodiacepina indicada en trastornos de pánico y crisis convulsivas.'),
  (13, 'MED-013', 'Diclofenaco Sódico', 'Diclofenaco', 4, 9, '50 mg', 'Caja x 20 tabletas', 12300.00, 105, FALSE, 'Analgésico antiinflamatorio para dolor agudo postraumático.'),
  (14, 'MED-014', 'Sertralina Anxiofree', 'Sertralina', 13, 12, '50 mg', 'Caja x 30 tabletas', 48500.00, 35, TRUE, 'Antidepresivo inhibidor selectivo de la recaptación de serotonina.'),
  (15, 'MED-015', 'Salbutamol Aerosol HFA', 'Salbutamol', 14, 6, '100 mcg/dosis', 'Inhalador 200 dosis', 24900.00, 80, FALSE, 'Broncodilatador de acción rápida para crisis asmáticas y broncoespasmo.'),
  (16, 'MED-016', 'Ciprofloxacino Bacterial', 'Ciprofloxacino', 2, 3, '500 mg', 'Caja x 10 tabletas', 26000.00, 42, TRUE, 'Fluoroquinolona de amplio espectro para infecciones urinarias complejas.'),
  (17, 'MED-017', 'Hidroclorotiazida Diur', 'Hidroclorotiazida', 7, 5, '25 mg', 'Caja x 30 tabletas', 9800.00, 90, TRUE, 'Diurético tiazídico coadyuvante en el manejo de la hipertensión arterial.'),
  (18, 'MED-018', 'Naproxeno Sódico', 'Naproxeno', 4, 3, '550 mg', 'Caja x 12 tabletas', 15400.00, 115, FALSE, 'Alivio potente del dolor inflamatorio osteomuscular y dental.'),
  (19, 'MED-019', 'Dexametasona Depo', 'Dexametasona', 8, 9, '4 mg/2 ml', 'Ampolla inyectable x 1', 8500.00, 65, TRUE, 'Corticoide sistémico potente para crisis alérgicas e inflamatorias severas.'),
  (20, 'MED-020', 'Levotiroxina Sódica', 'Levotiroxina', 10, 1, '100 mcg', 'Caja x 50 tabletas', 31000.00, 70, TRUE, 'Hormona tiroidea sintética de reemplazo en hipotiroidismo primario.'),
  (21, 'MED-021', 'Trimebutina Antispas', 'Trimebutina', 11, 15, '200 mg', 'Caja x 30 tabletas', 34500.00, 55, FALSE, 'Regulador de la motilidad digestiva para síndrome de colon irritable.'),
  (22, 'MED-022', 'Fluconazol Dermic', 'Fluconazol', 5, 12, '150 mg', 'Caja x 2 cápsulas', 19800.00, 85, FALSE, 'Antifúngico triazólico para candidiasis mucocutánea y sistémica.'),
  (23, 'MED-023', 'Enalapril Maleato', 'Enalapril', 7, 5, '20 mg', 'Caja x 30 tabletas', 11500.00, 100, TRUE, 'Inhibidor de la ECA para tratamiento de falla cardíaca e hipertensión.'),
  (24, 'MED-024', 'Clorfeniramina Maleato', 'Clorfeniramina', 3, 9, '4 mg', 'Caja x 20 tabletas', 6500.00, 140, FALSE, 'Antihistamínico clásico para rinitis estacional y prurito alérgico.'),
  (25, 'MED-025', 'Butilbromuro de Hioscina', 'Hioscina', 11, 4, '10 mg', 'Caja x 10 grageas', 13800.00, 90, FALSE, 'Antiespasmódico visceral para cólicos abdominales y renales.'),
  (26, 'MED-026', 'Tramadol Gotas', 'Tramadol Clorhidrato', 1, 7, '100 mg/ml', 'Frasco gotero 10 ml', 32000.00, 30, TRUE, 'Analgésico opioide atípico para dolor moderado a severo refractario.'),
  (27, 'MED-027', 'Pregabalina Neuropain', 'Pregabalina', 13, 12, '75 mg', 'Caja x 28 cápsulas', 56000.00, 45, TRUE, 'Modulador neuronal para neuropatía diabética y fibromialgia.'),
  (28, 'MED-028', 'Lansoprazol Gastric', 'Lansoprazol', 11, 16, '30 mg', 'Caja x 14 cápsulas', 22500.00, 65, FALSE, 'Inhibidor gástrico para cicatrización de úlcera duodenal activa.'),
  (29, 'MED-029', 'Metoprolol Tartrato', 'Metoprolol', 7, 2, '50 mg', 'Caja x 30 tabletas', 14200.00, 80, TRUE, 'Betabloqueador selectivo para arritmias y cardiopatía isquémica.'),
  (30, 'MED-030', 'Cefalexina Monohidrato', 'Cefalexina', 2, 9, '500 mg', 'Caja x 24 cápsulas', 33500.00, 50, TRUE, 'Cefalosporina de primera generación para infecciones de piel y tejidos.'),
  (31, 'MED-031', 'Aciclovir Dermacare', 'Aciclovir', 6, 5, '0.05', 'Tubo crema x 15 g', 16700.00, 75, FALSE, 'Antiviral tópico específico para herpes simple labial y genital inicial.'),
  (32, 'MED-032', 'Insulina Glargina Pen', 'Insulina Glargina', 10, 15, '100 UI/ml', 'Pluma precargada 3 ml', 89000.00, 20, TRUE, 'Análogo de insulina de acción ultraprolongada para diabetes mellitus.'),
  (33, 'MED-033', 'Meloxicam Flex', 'Meloxicam', 4, 9, '15 mg', 'Caja x 10 tabletas', 17900.00, 90, FALSE, 'Antiinflamatorio preferencial COX-2 para osteoartritis y artritis.'),
  (34, 'MED-034', 'Alprazolam Calmpill', 'Alprazolam', 13, 12, '0.5 mg', 'Caja x 30 tabletas', 29000.00, 25, TRUE, 'Tranquilizante menor para crisis de angustia y ansiedad generalizada.'),
  (35, 'MED-035', 'Budesonida PulmoInhaler', 'Budesonida', 14, 2, '200 mcg/dosis', 'Inhalador 200 dosis', 49500.00, 40, TRUE, 'Corticoide inhalado para control de mantenimiento en asma persistente.'),
  (36, 'MED-036', 'Carvedilol HeartCare', 'Carvedilol', 7, 13, '25 mg', 'Caja x 30 tabletas', 24000.00, 60, TRUE, 'Betabloqueador no selectivo vasodilatador en insuficiencia cardíaca.'),
  (37, 'MED-037', 'Furosemida Renal', 'Furosemida', 7, 5, '40 mg', 'Caja x 30 tabletas', 8700.00, 110, TRUE, 'Diurético de asa de alta potencia para edemas periféricos y pulmonares.'),
  (38, 'MED-038', 'Ketoconazol Medipill', 'Ketoconazol', 5, 8, '0.02', 'Frasco champú 120 ml', 28500.00, 50, FALSE, 'Tratamiento antimicótico para dermatitis seborreica y pitiriasis.'),
  (39, 'MED-039', 'Montelukast Broncho', 'Montelukast', 14, 11, '10 mg', 'Caja x 30 tabletas', 44000.00, 55, FALSE, 'Antagonista de receptores de leucotrienos para prevención asmática.'),
  (40, 'MED-040', 'Prednisona Immunocort', 'Prednisona', 8, 9, '20 mg', 'Caja x 30 tabletas', 22000.00, 70, TRUE, 'Inmunosupresor y antiinflamatorio esteroideo sistémico de rescate.'),
  (41, 'MED-041', 'Domperidona Gastrofluid', 'Domperidona', 11, 15, '10 mg', 'Caja x 20 tabletas', 15800.00, 80, FALSE, 'Procinético y antiemético para náuseas y vaciamiento gástrico lento.'),
  (42, 'MED-042', 'Claritromicina Protect', 'Claritromicina', 2, 1, '500 mg', 'Caja x 10 tabletas', 41000.00, 35, TRUE, 'Antibiótico macrólido coadyuvante en erradicación de H. pylori.'),
  (43, 'MED-043', 'Simvastatina Stat', 'Simvastatina', 7, 5, '20 mg', 'Caja x 30 tabletas', 13500.00, 90, TRUE, 'Estatina para control primario de dislipidemias e hipercolesterolemia.'),
  (44, 'MED-044', 'Ácido Acetilsalicílico Cardio', 'Ácido Acetilsalicílico', 7, 3, '100 mg', 'Caja x 30 tabletas', 11000.00, 160, FALSE, 'Antiagregante plaquetario profiláctico para eventos cardiovasculares.'),
  (45, 'MED-045', 'Miconazol Crema Vag', 'Miconazol', 5, 5, '0.02', 'Tubo crema x 40 g + aplicadores', 21500.00, 45, FALSE, 'Antimicótico ginecológico local para vulvovaginitis fúngica.'),
  (46, 'MED-046', 'Glibenclamida Diabet', 'Glibenclamida', 10, 9, '5 mg', 'Caja x 30 tabletas', 9200.00, 85, TRUE, 'Sulfonilurea estimulante de secreción de insulina pancreática.'),
  (47, 'MED-047', 'Betametasona Valerato', 'Betametasona', 9, 5, '0.001', 'Tubo crema x 30 g', 14900.00, 70, TRUE, 'Corticosteroide dermatológico tópico para dermatosis inflamatorias.'),
  (48, 'MED-048', 'Sucralfato Gastromucosa', 'Sucralfato', 11, 9, '1 g', 'Caja x 20 sobres granulado', 37500.00, 40, FALSE, 'Citoprotector gástrico de barrera mecánica sobre úlceras pépticas.'),
  (49, 'MED-049', 'Levofloxacino Bactrimax', 'Levofloxacino', 2, 15, '750 mg', 'Caja x 7 tabletas', 58000.00, 30, TRUE, 'Quinolona respiratoria de alta dosis para neumonía bacteriana adquirida.'),
  (50, 'MED-050', 'Electrolitos Orales Pediátricos', 'Sales de Rehidratación Oral', 12, 1, 'Electrolitos balanceados', 'Frasco x 500 ml solución oral', 8500.00, 120, FALSE, 'Rehidratación oral para prevención de deshidratación por diarrea o vómito.')
ON CONFLICT (id) DO UPDATE SET
  sku                   = EXCLUDED.sku,
  name                  = EXCLUDED.name,
  active_ingredient     = EXCLUDED.active_ingredient,
  category_id           = EXCLUDED.category_id,
  manufacturer_id       = EXCLUDED.manufacturer_id,
  dosage                = EXCLUDED.dosage,
  presentation          = EXCLUDED.presentation,
  price_cop             = EXCLUDED.price_cop,
  stock                 = EXCLUDED.stock,
  requires_prescription = EXCLUDED.requires_prescription,
  description           = EXCLUDED.description;
SELECT setval(pg_get_serial_sequence('medications','id'), (SELECT MAX(id) FROM medications));

COMMIT;

-- Verificacion rapida de la carga (debe imprimir 50 / 14 / 16 / 27)
SELECT
  (SELECT COUNT(*) FROM medications)                                   AS medicamentos,
  (SELECT COUNT(*) FROM categories)                                    AS categorias,
  (SELECT COUNT(*) FROM manufacturers)                                 AS laboratorios,
  (SELECT COUNT(*) FROM medications WHERE requires_prescription)       AS con_formula_medica;
