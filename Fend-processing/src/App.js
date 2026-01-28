import { useEffect, useState, useMemo, useCallback } from "react";
import { BrowserRouter as Router, Routes, Route, useParams, useNavigate } from "react-router-dom";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || "http://localhost:5000";

const apiRequest = async (path, options = {}) => {
  const defaultOptions = { cache: 'no-store' };
  const finalOptions = { ...defaultOptions, ...options };
  const res = await fetch(apiBaseUrl + path, finalOptions);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Request failed");
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return null;
};

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || "";
      const parts = String(result).split(",");
      resolve(parts[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

const safeParse = (val) => {
  if (!val) return [];
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return []; }
  }
  if (Array.isArray(val)) return val;
  return [];
};
const num = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const cleaned = String(v).replace(/,/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
};
const normalizeRows = (inv) => {
  const productname = safeParse(inv.productname);
  const description = safeParse(inv.description);
  const quantity = safeParse(inv.quantity);
  const units = safeParse(inv.units);
  const rate = safeParse(inv.rate);
  const maxLen = Math.max(productname.length, description.length, quantity.length, units.length, rate.length);
  const rows = [];
  for (let i = 0; i < maxLen; i++) {
    const row = {
      productname: productname[i] ?? "",
      description: description[i] ?? "",
      quantity: quantity[i] ?? "",
      units: units[i] ?? "",
      rate: rate[i] ?? "",
    };
    const hasAny = String(row.productname).trim() || String(row.description).trim() || String(row.quantity).trim() || String(row.units).trim() || String(row.rate).trim();
    if (hasAny) rows.push(row);
  }
  return rows;
};

// ---------------- PDF Generation ----------------
const generatePDFBlob = (invoiceLike) => {
  const rows = normalizeRows(invoiceLike);
  const doc = new jsPDF();
  doc.setFontSize(18);
  doc.text("INVOICE", 105, 20, { align: "center" });
  doc.setFontSize(12);
  doc.text(`Invoice No: ${invoiceLike.invoice_number ?? ""}`, 20, 40);
  doc.text(`Dealer: ${invoiceLike.Dealer ?? ""}`, 20, 50);
  doc.text(`Phone: ${invoiceLike.phonenumber ?? ""}`, 20, 60);
  doc.text(`Date: ${invoiceLike.invoice_date ?? ""}`, 20, 70);
  doc.text(`Status: ${invoiceLike.status ?? ""}`, 20, 80);

  let total = 0;
  const tableData = rows.map((r) => {
    const qty = num(r.quantity);
    const rate = num(r.rate);
    const line = qty * rate;
    total += line;
    return [r.productname || "", r.description || "", String(qty), r.units || "", rate.toFixed(2), line.toFixed(2)];
  });

  autoTable(doc, {
    startY: 95,
    head: [["Product", "Description", "Quantity", "Units", "Rate", "Amount"]],
    body: [...tableData, ["", "", "", "", "Total", total.toFixed(2)]],
    theme: "grid",
    styles: { halign: "center", valign: "middle" },
  });

  const finalY = doc.lastAutoTable?.finalY ?? 120;
  doc.text("Authorized Signature: ____________________", 20, finalY + 20);
  return doc.output("blob");
};

function InvoicePage() {
  const { uuid, phone } = useParams();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState([]);
  const [showPending, setShowPending] = useState(false);

  const fetchInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest(`/invoices/${uuid}/${phone}`);
      setInvoice(data || null);
    } catch (error) {
      console.error(error);
      alert("Failed to load invoice");
    } finally {
      setLoading(false);
    }
  }, [uuid, phone]);

  useEffect(() => { fetchInvoice(); }, [fetchInvoice]);

  useEffect(() => {
    (async () => {
      if (!phone) return;
      try {
        const data = await apiRequest(`/invoices/pending?phone=${phone}`);
        if (Array.isArray(data)) setPending(data);
      } catch (error) {
        console.error(error);
      }
    })();
  }, [phone]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.pending-dropdown')) {
        setShowPending(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Close dropdown when route changes
  useEffect(() => {
    setShowPending(false);
  }, [uuid, phone]);

  // Edit handlers
  const handleEdit = () => {
    const rows = normalizeRows(invoice);
    setEditId(invoice.phonenumber);
    setEditData({ ...invoice, rows });
  };
  const handleChangeHeader = (field, value) => setEditData((s) => ({ ...s, [field]: value ?? "" }));
  const handleRowChange = (index, field, value) => {
    setEditData((s) => {
      const rows = [...s.rows];
      rows[index] = { ...rows[index], [field]: value ?? "" };
      return { ...s, rows };
    });
  };
  const addRow = () => setEditData((s) => ({ ...s, rows: [...s.rows, { productname:"", description:"", quantity:"", units:"", rate:"" }] }));
  const removeRow = (i) => setEditData((s) => ({ ...s, rows: s.rows.filter((_, idx) => idx !== i) }));

  const calcEditTotals = useMemo(() => {
    if (!editId || !editData?.rows) return { lines: [], total: 0 };
    const lines = editData.rows.map((r) => num(r.quantity) * num(r.rate));
    const total = lines.reduce((a, b) => a + b, 0);
    return { lines, total };
  }, [editId, editData]);

  const handleSave = async () => {
    try {
      setLoading(true);
      const rows = (editData.rows || []).filter((r) =>
        String(r.productname).trim() || String(r.description).trim() || String(r.quantity).trim() || String(r.units).trim() || String(r.rate).trim()
      );
      const payload = {
        invoice_number: editData.invoice_number ?? "",
        Dealer: editData.Dealer ?? "",
        phonenumber: editData.phonenumber ?? "",
        invoice_date: editData.invoice_date ?? "",
        productname: JSON.stringify(rows.map(r=>r.productname ?? "")),
        description: JSON.stringify(rows.map(r=>r.description ?? "")),
        quantity: JSON.stringify(rows.map(r=>r.quantity ?? "")),
        units: JSON.stringify(rows.map(r=>r.units ?? "")),
        rate: JSON.stringify(rows.map(r=>r.rate ?? "")),
        amount: calcEditTotals.total,
        total: calcEditTotals.total,
        status: "DRAFT",
      };
      const saved = await apiRequest(`/invoices/${uuid}/${editId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      alert("💾 Saved!");

      // If phone number changed, navigate to new URL
      if (saved && saved.phonenumber && String(saved.phonenumber) !== String(phone)) {
        navigate(`/${uuid}/${saved.phonenumber}`);
        return;
      }

      setEditId(null);
      await fetchInvoice();
    } catch(e) { console.error(e); alert("❌ Save failed"); } finally { setLoading(false); }
  };

  const handleApprove = async () => {
    try {
      setLoading(true);
      const rows = normalizeRows(invoice);
      const total = rows.map(r=>num(r.quantity)*num(r.rate)).reduce((a,b)=>a+b,0);

      const pdfBlob = generatePDFBlob({ ...invoice, status:"APPROVED" });
      const pdfBase64 = await blobToBase64(pdfBlob);
      await apiRequest(`/invoices/${uuid}/${invoice.phonenumber}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_number: invoice.invoice_number,
          phonenumber: invoice.phonenumber,
          total,
          pdfBase64,
        }),
      });

      alert("✅ Approved, PDF uploaded & webhook sent!");
      await fetchInvoice();
    } catch(e) { console.error(e); alert("❌ Approve failed"); } finally { setLoading(false); }
  };

  if(loading) return <p style={{textAlign:"center"}}>Loading...</p>;
  if(!invoice) return <p style={{textAlign:"center"}}>Invoice not found!</p>;

  const rows = normalizeRows(invoice);
  const total = rows.map(r=>num(r.quantity)*num(r.rate)).reduce((a,b)=>a+b,0);
  const isEditing = editId === invoice.phonenumber;

  // Responsive styles
  // You can move these styles to a CSS file for better maintainability.
  const cellPad = {
    padding: "0.75rem",
    border: "1px solid #ddd",
    fontSize: "1rem",
    whiteSpace: "nowrap",
    minWidth: 80
  };
  const tableBase = {
    width: "100%",
    borderCollapse: "collapse",
    marginTop: 20,
    fontSize: "1rem",
    tableLayout: "auto"
  };
  const inputBase = {
    width: "100%",
    minWidth: 300,
    padding: "0.5rem 0.75rem",
    boxSizing: "border-box",
    border: "2px solid #007bff",
    borderRadius: 6,
    fontSize: "1rem",
    outline: "none",
    transition: "border-color 0.2s",
    whiteSpace: "nowrap"
  };

  // Mobile responsiveness
  const mainContainer = {
    fontFamily: "Segoe UI, sans-serif",
    background: "#f7f7f7",
    minHeight: "100vh",
    padding: 0,
  };
  const cardContainer = {
    width: "100%",
    maxWidth: 800,
    margin: "0 auto",
    background: "#fff",
    boxShadow: "0 8px 16px rgba(0,0,0,0.08)",
    padding: "24px 8px",
    opacity: loading ? 0.6 : 1,
    minHeight: "70vh",
    borderRadius: "14px"
  };

  const responsiveTableWrapper = {
    overflowX: "auto",
    width: "100%",
    marginBottom: "1rem"
  };

  // Add media queries using a <style> tag for more control
  // But keep most layout in JS for your original structure

  return (
    <div style={mainContainer}>
      <style>
        {`
          @media (max-width: 600px) {
            .invoice-title { font-size: 1.2rem !important; }
            .invoice-header, .invoice-status, .invoice-fields { font-size: 0.95rem !important; }
            .pending-dropdown { min-width: 180px !important; }
            .pending-dropdown-content { max-width: 95vw !important; font-size: 0.95rem !important; }
            table { font-size: 0.95rem !important; }
            th, td { padding: 0.5rem !important; }
            .action-btn { font-size: 0.95rem !important; padding: 0.5rem 1rem !important; }
          }
          @media (max-width: 400px) {
            .invoice-title { font-size: 1rem !important; }
            .action-btn { font-size: 0.8rem !important; padding: 0.4rem 0.6rem !important; }
          }
        `}
      </style>

      {/* Top Navbar with Not approved dropdown */}
      <div style={{ 
        position:"fixed",
        top:0,
        left:0,
        right:0,
        background:"#fff",
        boxShadow:"0 2px 8px rgba(0,0,0,0.11)",
        zIndex:100,
        padding:"12px 8px"
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", maxWidth:800, margin:"0 auto" }}>
          <div className="invoice-title" style={{ fontWeight:600, fontSize:"1.4rem" }}>Invoice Management</div>
          <div className="pending-dropdown" style={{ position:"relative", minWidth:200 }}>
            <button 
              onClick={() => setShowPending(!showPending)}
              style={{ 
                padding:"8px 16px",
                fontSize:"1rem",
                cursor:"pointer",
                border:"1px solid #ddd",
                borderRadius:6,
                background:"#007bff",
                color:"white",
                fontWeight:"bold"
              }}
            >
              Not Approved ({pending.length})
            </button>
            {showPending && (
              <div className="pending-dropdown-content" style={{ 
                position:"absolute",
                top:"100%",
                right:0,
                marginTop:8,
                background:"#fff",
                borderRadius:8,
                boxShadow:"0 4px 12px rgba(0,0,0,0.15)",
                minWidth:220,
                maxWidth:"95vw",
                maxHeight:"65vh",
                overflowY:"auto",
                border:"1px solid #ddd",
                zIndex:1000
              }}>
                <div style={{ padding:12, borderBottom:"1px solid #eee", fontWeight:600 }}>Not approved</div>
                <div style={{ maxHeight:"calc(65vh - 50px)", overflowY:"auto" }}>
                  {pending.length === 0 && <div style={{ padding:20, textAlign:"center", color:"#888" }}>All approved</div>}
                  {pending.map((p)=>{
                    const isActive = String(p.uuid) === String(uuid) && String(p.phonenumber) === String(phone);
                    return (
                      <a key={p.uuid} href={`/${p.uuid}/${p.phonenumber}`} style={{ textDecoration:"none", display:"block" }}>
                        <div style={{ 
                          borderBottom:"1px solid #eee", 
                          padding:12,
                          cursor:"pointer",
                          background:isActive?"#f0f6ff":"#fff",
                          transition:"background 0.2s"
                        }}
                        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "#f5f5f5"; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "#fff"; }}
                        >
                          <div style={{ color:"#0b5", fontWeight:600, fontSize:14 }}>{p.phonenumber}</div>
                          <div style={{ fontSize:12, color:"#666" }}>{p.Dealer || "Unknown"}</div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main invoice card - Full width scrollable */}
      <div style={{ 
        marginTop:70,
        width:"100%",
        minHeight:"calc(100vh - 70px)",
        background:"#f7f7f7"
      }}>
        <div style={cardContainer}>
        <h2 className="invoice-title" style={{marginBottom:20, fontSize:"1.4rem"}}>INVOICE: {isEditing ? <input value={editData.invoice_number ?? ""} onChange={e=>handleChangeHeader("invoice_number", e.target.value)} style={{width:"100%", maxWidth:300, padding:"12px 14px", fontSize:"1rem", border:"2px solid #007bff", borderRadius:6, outline:"none"}}/> : invoice.invoice_number}</h2>

        {isEditing ? (
          <div className="invoice-fields" style={{ display:"grid", gap:15, marginBottom:20 }}>
            <div><label style={{fontSize:"1rem", fontWeight:"bold", display:"block", marginBottom:5}}>Dealer:</label> <input value={editData.Dealer ?? ""} onChange={e=>handleChangeHeader("Dealer", e.target.value)} style={{width:"100%", maxWidth:400, padding:"0.5rem 0.75rem", fontSize:"1rem", border:"2px solid #007bff", borderRadius:6, outline:"none", boxSizing:"border-box"}}/></div>
            <div><label style={{fontSize:"1rem", fontWeight:"bold", display:"block", marginBottom:5}}>Phone:</label> <input value={editData.phonenumber ?? ""} onChange={e=>handleChangeHeader("phonenumber", e.target.value)} type="tel" style={{width:"100%", maxWidth:400, padding:"0.5rem 0.75rem", fontSize:"1rem", border:"2px solid #007bff", borderRadius:6, outline:"none", boxSizing:"border-box"}}/></div>
            <div><label style={{fontSize:"1rem", fontWeight:"bold", display:"block", marginBottom:5}}>Date:</label> <input value={editData.invoice_date ?? ""} onChange={e=>handleChangeHeader("invoice_date", e.target.value)} type="date" style={{width:"100%", maxWidth:400, padding:"0.5rem 0.75rem", fontSize:"1rem", border:"2px solid #007bff", borderRadius:6, outline:"none", boxSizing:"border-box"}}/></div>
            <div className="invoice-status" style={{fontSize:"1rem", padding:"0.5rem 0.75rem", background:"#f0f0f0", borderRadius:6}}><b>Status:</b> {invoice.status}</div>
          </div>
        ) : (
          <div className="invoice-header" style={{ lineHeight:2, fontSize:"1rem", marginBottom:20 }}>
            <b>DEALER:</b> {invoice.Dealer}<br/>
            <b>PHONE:</b> {invoice.phonenumber}<br/>
            <b>DATE:</b> {invoice.invoice_date}<br/>
            <b>STATUS:</b> {invoice.status}<br/>
            {invoice.pdf_url && <div style={{marginTop:10}}><a href={invoice.pdf_url} target="_blank" rel="noreferrer" style={{fontSize:"1rem"}}>📄 View PDF</a></div>}
          </div>
        )}

        <div style={responsiveTableWrapper}>
        <table style={tableBase}>
          <thead>
            <tr style={{background:"#f0f0f0", fontWeight:"bold"}}>
              <th style={cellPad}>PRODUCT</th>
              <th style={cellPad}>DESCRIPTION</th>
              <th style={cellPad}>QUANTITY</th>
              <th style={cellPad}>UNITS</th>
              <th style={cellPad}>RATE</th>
              <th style={cellPad}>AMOUNT</th>
              {isEditing && <th style={cellPad}>ACTION</th>}
            </tr>
          </thead>
          <tbody>
            {(isEditing ? editData.rows : rows).map((r,i)=>{
              const amount = num(r.quantity)*num(r.rate);
              return (
                <tr key={i}>
                  {isEditing ? (
                    <>
                      <td style={cellPad}><input value={r.productname ?? ""} onChange={e=>handleRowChange(i,"productname",e.target.value)} style={inputBase} onFocus={(e)=>e.target.style.borderColor="#28a745"} onBlur={(e)=>e.target.style.borderColor="#007bff"} /></td>
                      <td style={cellPad}><input value={r.description ?? ""} onChange={e=>handleRowChange(i,"description",e.target.value)} style={inputBase} onFocus={(e)=>e.target.style.borderColor="#28a745"} onBlur={(e)=>e.target.style.borderColor="#007bff"} /></td>
                      <td style={cellPad}><input value={r.quantity ?? ""} onChange={e=>handleRowChange(i,"quantity",e.target.value)} type="number" style={{...inputBase, textAlign:"right"}} onFocus={(e)=>e.target.style.borderColor="#28a745"} onBlur={(e)=>e.target.style.borderColor="#007bff"} /></td>
                      <td style={cellPad}><input value={r.units ?? ""} onChange={e=>handleRowChange(i,"units",e.target.value)} style={inputBase} onFocus={(e)=>e.target.style.borderColor="#28a745"} onBlur={(e)=>e.target.style.borderColor="#007bff"} /></td>
                      <td style={cellPad}><input value={r.rate ?? ""} onChange={e=>handleRowChange(i,"rate",e.target.value)} type="number" style={{...inputBase, textAlign:"right"}} onFocus={(e)=>e.target.style.borderColor="#28a745"} onBlur={(e)=>e.target.style.borderColor="#007bff"} /></td>
                      <td style={{...cellPad, textAlign:"right"}}>{amount.toFixed(2)}</td>
                      <td style={cellPad}><button className="action-btn" onClick={()=>removeRow(i)} style={{padding:"8px 16px", fontSize:"1rem", cursor:"pointer", border:"none", borderRadius:6, background:"#dc3545", color:"white", fontWeight:"bold", width:"100%"}}>Remove</button></td>
                    </>
                  ) : (
                    <>
                      <td style={cellPad}>{r.productname}</td>
                      <td style={cellPad}>{r.description}</td>
                      <td style={{...cellPad, textAlign:"right"}}>{r.quantity}</td>
                      <td style={cellPad}>{r.units}</td>
                      <td style={{...cellPad, textAlign:"right"}}>{r.rate}</td>
                      <td style={{...cellPad, textAlign:"right"}}>{amount.toFixed(2)}</td>
                    </>
                  )}
                </tr>
              )
            })}
            <tr>
              <td colSpan={5} style={{...cellPad, textAlign:"right", fontWeight:"bold"}}>TOTAL</td>
              <td style={{...cellPad, fontWeight:"bold", textAlign:"right"}}>{isEditing ? calcEditTotals.total.toFixed(2) : total.toFixed(2)}</td>
              {isEditing && <td style={cellPad}></td>}
            </tr>
          </tbody>
        </table>
        </div>

        <div style={{display:"flex", gap:15, marginTop:30, flexWrap:"wrap"}}>
          {isEditing ? (
            <>
              <button className="action-btn" onClick={addRow} style={{padding:"10px 18px", fontSize:"1rem", cursor:"pointer", border:"none", borderRadius:6, background:"#007bff", color:"white", fontWeight:"bold"}}>Add Item</button>
              <button className="action-btn" onClick={handleSave} style={{padding:"10px 18px", fontSize:"1rem", cursor:"pointer", border:"none", borderRadius:6, background:"#28a745", color:"white", fontWeight:"bold"}}>Save</button>
            </>
          ) : (
            <>
              <button className="action-btn" onClick={handleEdit} style={{padding:"10px 18px", fontSize:"1rem", cursor:"pointer", border:"none", borderRadius:6, background:"#007bff", color:"white", fontWeight:"bold"}}>Edit</button>
              <button className="action-btn" onClick={handleApprove} style={{padding:"10px 18px", fontSize:"1rem", cursor:"pointer", border:"none", borderRadius:6, background:"#28a745", color:"white", fontWeight:"bold"}}>Approve</button>
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Main App with Router ----------------
export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/:uuid/:phone" element={<InvoicePage />} />
        <Route
          path="/"
          element={
            <p style={{textAlign:'center',marginTop:50}}>
              Enter <b>/UUID/PHONE_NUMBER</b> in URL to view your invoice.
            </p>
          }
        />
      </Routes>
    </Router>
  );
}
