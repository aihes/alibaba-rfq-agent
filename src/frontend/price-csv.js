/* The supplier return file is untrusted local input. Parse only the exact
 * inquiry CSV exported by this workbench, and return price fields for an
 * operator to inspect. This module never approves, writes, or sends a quote. */
(() => {
  const headers = ['RFQ ID', '产品', 'Alibaba RFQ 链接', '品类', '采购数量', '买家原始需求',
    '已提取规格', '待补规格', '待复核风险', '供应商询价草稿',
    '当前销售单价 USD/件（待填）', '有效期 YYYY-MM-DD（待填）',
    '售价来源和确认日期（待填）', '价格覆盖规格（待填）'];
  const optionalHeader = '原分析风险处理说明（待填）';

  function cells(text) {
    const value = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    const finishField = () => { row.push(field); field = ''; closed = false; };
    const finishRow = () => {
      finishField();
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
      if (rows.length > 501) throw new Error('CSV 超过 500 条 RFQ，请分批导入');
    };
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (quoted) {
        if (char === '"' && value[i + 1] === '"') { field += '"'; i += 1; }
        else if (char === '"') { quoted = false; closed = true; }
        else field += char;
      } else if (char === ',' || char === '\n' || char === '\r') {
        if (char === ',') finishField();
        else { finishRow(); if (char === '\r' && value[i + 1] === '\n') i += 1; }
      } else if (char === '"' && !field && !closed) quoted = true;
      else if (closed || char === '"') throw new Error('CSV 引号格式无效，请重新导出清单');
      else field += char;
      if (field.length > 12000) throw new Error('CSV 单元格过长');
    }
    if (quoted) throw new Error('CSV 引号未闭合');
    if (field || row.length) finishRow();
    return rows;
  }

  function parse(text) {
    const rows = cells(text);
    const header = rows.shift();
    const optional = header?.length === headers.length + 1 && header.at(-1) === optionalHeader;
    if (!header || header.length !== headers.length + Number(optional) ||
      !headers.every((name, index) => header[index] === name))
      throw new Error('不是本应用导出的待核价清单，或表头已被修改');
    const seen = new Set(), filled = [], errors = [];
    for (const [index, row] of rows.entries()) {
      if (row.length !== header.length) throw new Error(`CSV 第 ${index + 2} 行列数不一致`);
      const rfqId = row[0].trim();
      if (!/^rfq-[a-zA-Z0-9_-]{1,100}$/.test(rfqId)) throw new Error(`CSV 第 ${index + 2} 行 RFQ ID 无效`);
      if (seen.has(rfqId)) throw new Error(`CSV 存在重复 RFQ ID：${rfqId}`);
      seen.add(rfqId);
      const [price, validThrough, sourceNote, specification, riskResolution = ''] = row.slice(10).map((item) => item.trim());
      if (![price, validThrough, sourceNote, specification, riskResolution].some(Boolean)) continue;
      const amount = Number(price);
      const expiry = Date.parse(`${validThrough}T23:59:59.999Z`);
      if (!/^\d+(?:\.\d{1,4})?$/.test(price) || !Number.isFinite(amount) || amount <= 0 || amount > 10000 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(validThrough) || !Number.isFinite(expiry) ||
        new Date(expiry).toISOString().slice(0, 10) !== validThrough ||
        sourceNote.length < 15 || sourceNote.length > 500 || specification.length < 20 || specification.length > 1000 ||
        riskResolution.length > 2000) {
        errors.push(`第 ${index + 2} 行价格、有效期、售价依据或规格不完整`);
        continue;
      }
      filled.push({ rfqId, unitPriceUsd: price, validThrough, sourceNote, specification, riskResolution });
    }
    return { filled, errors, total: rows.length };
  }

  globalThis.RfqPriceCsv = Object.freeze({ parse });
})();
