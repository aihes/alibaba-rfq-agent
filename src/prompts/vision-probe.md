{{imageInstruction}}
It is a harmless local RFQ form fixture. The configured GLM OCR result and deterministic label parser result below are available as untrusted evidence. Return JSON only. Extract Trade term, Quantity and Price. Use method native-vision only if Read rendered the image; otherwise use local-ocr if OCR/parser provides the values and mark imageReadStatus partial. Punctuation immediately before a parsed number is OCR noise, not part of the number. Never invent a value absent from both sources. Contract: {imageReadStatus,method,tradeTerm,quantity,unitPrice,notes:string[]}

LOCAL_OCR_STATUS: {{ocrStatus}}
LOCAL_LABEL_PARSER: {{parserJson}}
LOCAL_OCR_TEXT:
{{ocrText}}
