/**
 * Qwen2.5-VL OCR Service Client
 * Node.js client for interacting with the Python Qwen OCR service
 */

import axios from 'axios'
import FormData from 'form-data'

const QWEN_SERVICE_URL = process.env.QWEN_SERVICE_URL || 'http://localhost:5000'

/**
 * Extract data from PDF using Qwen2.5-VL service
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} filename - Original filename
 * @param {string|null} customPrompt - Custom extraction prompt (optional)
 * @returns {Promise<Object>} Extracted data with text, markdown, and metadata
 */
export async function extractWithQwen(pdfBuffer, filename = 'invoice.pdf', customPrompt = null) {
  const url = `${QWEN_SERVICE_URL}/ocr`
  console.log(`[Qwen] Attempting to connect to: ${url}`)
  console.log(`[Qwen] PDF size: ${pdfBuffer.length} bytes, filename: ${filename}`)
  
  // Skip health check - proceed directly with OCR request
  // (Health checks were timing out, but OCR endpoint may still work)
  
  try {
    const formData = new FormData()
    formData.append('pdf', pdfBuffer, {
      filename: filename,
      contentType: 'application/pdf'
    })
    
    // Note: Python service uses a hardcoded prompt for now
    // Custom prompt support can be added to Python service if needed

    console.log(`[Qwen] Sending POST request to ${url}...`)
    const response = await axios.post(
      url,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 1200000, // 20 minutes for large PDFs and slow processing
        responseType: 'json',
      }
    )
    
    console.log(`[Qwen] Received response with status: ${response.status}`)

    if (response.data && response.data.success && response.data.invoice_json) {
      // The Python service returns invoice_json as a JSON object (FastAPI auto-serializes)
      const invoiceJson = response.data.invoice_json
      
      // Convert to string if it's an object
      const invoiceJsonString = typeof invoiceJson === 'string' 
        ? invoiceJson 
        : JSON.stringify(invoiceJson)
      
      return {
        text: invoiceJsonString, // The JSON string from Qwen
        markdown: invoiceJsonString, // Can be used as markdown
        pages: [],
        extracted: true,
        confidence: 0.95, // Qwen models are highly accurate
        model: 'Qwen2.5-VL',
        pageCount: 1
      }
    }

    throw new Error('Invalid response from Qwen service')
  } catch (error) {
    console.error('[Qwen] Error details:', {
      code: error.code,
      message: error.message,
      hasResponse: !!error.response,
      hasRequest: !!error.request,
      responseStatus: error.response?.status,
      responseData: error.response?.data,
      url: url
    })
    
    if (error.code === 'ECONNREFUSED') {
      console.error(`[Qwen] Connection refused to ${url}. Is the service running?`)
      throw new Error(`Qwen service connection refused. Please ensure the Qwen service is running on port 5000 at ${QWEN_SERVICE_URL}`)
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      console.error(`[Qwen] Request timeout to ${url}`)
      throw new Error(`Qwen service request timeout. The service may be overloaded or not responding.`)
    }
    if (error.response) {
      const status = error.response.status
      const errorData = error.response.data || {}
      const errorDetail = errorData.detail || errorData.message || JSON.stringify(errorData)
      
      console.error(`[Qwen] Service returned error status ${status}:`, errorDetail)
      throw new Error(`Qwen extraction failed: ${errorDetail}`)
    }
    if (error.request) {
      console.error(`[Qwen] Request made but no response received from ${url}`)
      console.error(`[Qwen] Request details:`, {
        method: error.config?.method,
        url: error.config?.url,
        timeout: error.config?.timeout
      })
      throw new Error(`Qwen service is not responding at ${url}. Please ensure the Qwen service is running on port 5000.`)
    }
    throw new Error(`Qwen request failed: ${error.message}`)
  }
}

/**
 * Extract weight from weight slip PDF using Qwen2.5-VL service
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} Extracted weight data
 */
export async function extractWeightFromPDF(pdfBuffer, filename = 'weight-slip.pdf') {
  const url = `${QWEN_SERVICE_URL}/extract-weight`
  console.log(`[Qwen] Extracting weight from: ${filename}`)
  
  try {
    const formData = new FormData()
    formData.append('pdf', pdfBuffer, {
      filename: filename,
      contentType: 'application/pdf'
    })

    console.log(`[Qwen] Sending POST request to ${url}...`)
    const response = await axios.post(
      url,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 120000, // 2 minutes
        responseType: 'json',
      }
    )
    
    console.log(`[Qwen] Weight extraction response:`, response.data)

    if (response.data && response.data.success !== undefined) {
      return {
        weight: response.data.weight || null,
        success: response.data.success
      }
    }

    throw new Error('Invalid response from Qwen weight extraction service')
  } catch (error) {
    console.error('[Qwen] Weight extraction error:', {
      code: error.code,
      message: error.message,
      hasResponse: !!error.response,
      responseStatus: error.response?.status,
      responseData: error.response?.data
    })
    
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`Qwen service connection refused. Please ensure the Qwen service is running on port 5000`)
    }
    if (error.response) {
      const errorData = error.response.data || {}
      const errorDetail = errorData.detail || errorData.message || JSON.stringify(errorData)
      throw new Error(`Weight extraction failed: ${errorDetail}`)
    }
    throw new Error(`Weight extraction request failed: ${error.message}`)
  }
}

/**
 * Check if Qwen service is available and model is loaded
 * @returns {Promise<Object>} Health status
 */
export async function checkQwenHealth() {
  try {
    const response = await axios.get(`${QWEN_SERVICE_URL}/health`, {
      timeout: 5000
    })
    return response.data
  } catch (error) {
    return { 
      status: 'error', 
      error: error.message,
      model_loaded: false
    }
  }
}
