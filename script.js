const { useState, useEffect, useRef } = React;

const Icon = ({ name, size = 24, className = "" }) => {
    const iconRef = useRef(null);
    useEffect(() => {
        if (iconRef.current && window.lucide) {
            const iconName = name.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
            iconRef.current.innerHTML = `<i data-lucide="${iconName}" class="${className}"></i>`;
            window.lucide.createIcons({ root: iconRef.current });
        }
    }, [name, size, className]);
    return <span ref={iconRef} style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}></span>;
};

const MODEL_NAME = "gemini-flash-latest";

// 병렬 처리를 위한 고도로 최적화된 스키마
const SCHEMAS = {
    PLAN: {
        type: "OBJECT",
        properties: {
            summary: { type: "STRING" },
            categoryNames: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["summary", "categoryNames"]
    },
    DETAIL: {
        type: "OBJECT",
        properties: {
            summary: { type: "STRING" },
            count: { type: "INTEGER" },
            opinions: { type: "STRING", description: "쉼표로 구분된 ID 목록 (예: 0,3,15)" }
        },
        required: ["summary", "count", "opinions"]
    }
};

const PROMPTS = {
    // 1단계: 카테고리만 빠르게 정의
    PLAN: (data, isUX = false) => `Data: "${data}"\n당신은 Senior UX 리서처입니다. 데이터를 분석하여 ${isUX ? 'UX/디자인 관점의 심화' : '전체적인'} 카테고리 5~7개를 정의하고 전체 요약을 작성하십시오. ** 강조 표시 금지.`,
    
    // 2단계: 정의된 카테고리에 맞춰 데이터 매핑 (병렬 호출용)
    MAPPING: (data, catName) => `Data: "${data}"\n카테고리: [${catName}]\n이 카테고리에 해당하는 데이터의 ID와 4-5줄의 상세 요약을 작성하십시오. "opinions"는 반드시 숫자와 쉼표로만 구성된 문자열이어야 합니다.`,

    // 원인 분석 및 가설 (기존 로직 유지)
    ANALYSIS: (perspective, input, note) => `You are a Senior Root Cause Analyst. Lens: [${perspective}]. \n${note ? `[Request]: ${note}` : ""}\nDerivate 3 to 6 distinct 5Why chains. JSON: { "rootCauses": [ { "id": 1, "chain": ["Why 1..."], "realCause": "..." } ] }`,
    HYPOTHESIS: (perspective, cause) => `전문 UX 전략 컨설턴트로서 [${perspective}] 관점에서 원인 [${cause}]에 대한 해결 가설 2개를 제안하십시오. Step 1~3 각 3-4줄 상세 작성.`,
    SUMMARY: (cause, hypo) => `Senior Insight Strategist로서 분석 원인[${cause}]과 가설[${hypo}]을 바탕으로 최종 리포트를 작성하십시오.`
};

const App = () => {
    const [apiKey, setApiKey] = useState("");
    const [step, setStep] = useState(0); 
    const [rawData, setRawData] = useState("");
    const [itemCount, setItemCount] = useState(0);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [error, setError] = useState(null);
    
    const [step1Result, setStep1Result] = useState(null);
    const [step2Result, setStep2Result] = useState(null);
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [deepDiveInput, setDeepDiveInput] = useState("");
    const [perspective, setPerspective] = useState("사용 불편 관점");
    const [rootCauses, setRootCauses] = useState([]);
    const [selectedCauseId, setSelectedCauseId] = useState(null);
    const [deepHypotheses, setDeepHypotheses] = useState([]);
    const [selectedDeepHypoId, setSelectedDeepHypoId] = useState(null);
    const [finalBrief, setFinalBrief] = useState(null);
    const [qaInput, setQaInput] = useState("");
    const [opinionModal, setOpinionModal] = useState({ visible: false, title: "", opinions: [] });

    // API 호출 핵심 (최적화 온도 0.1 적용)
    const callGemini = async (prompt, schema = null) => {
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { 
                temperature: 0.1,
                responseMimeType: "application/json",
                ...(schema && { responseSchema: schema })
            }
        };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        return JSON.parse(json.candidates[0].content.parts[0].text);
    };

    // 병렬 분석 엔진 (속도 향상의 핵심)
    const runParallelAnalysis = async (isUX = false) => {
        setIsAnalyzing(true);
        try {
            const numberedData = rawData.split('\n').map((line, i) => `[ID:${i}] ${line}`).join('\n');
            
            // 1. 카테고리 설계 (Plan)
            const plan = await callGemini(PROMPTS.PLAN(numberedData, isUX), SCHEMAS.PLAN);
            
            // 2. 카테고리별 상세 분석 병렬 실행 (Concurrency)
            const detailPromises = plan.categoryNames.map(name => 
                callGemini(PROMPTS.MAPPING(numberedData, name), SCHEMAS.DETAIL)
                    .then(detail => ({
                        name,
                        summary: detail.summary,
                        count: detail.count,
                        opinions: detail.opinions.split(',').map(id => rawData.split('\n')[parseInt(id.trim())]).filter(Boolean)
                    }))
            );

            const categories = await Promise.all(detailPromises);
            const result = { summary: plan.summary, [isUX ? 'uxCategories' : 'categories']: categories };
            
            if(isUX) { setStep2Result(result); setStep(3); }
            else { setStep1Result(result); setStep(2); }
        } catch (err) { setError("분석 중 오류가 발생했습니다."); }
        finally { setIsAnalyzing(false); }
    };

    const validateKey = async (k) => {
        if(!k) return;
        setIsAnalyzing(true);
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${k}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
            });
            if(res.ok) { setApiKey(k); setStep(1); } else throw new Error();
        } catch { setError("API 키가 올바르지 않습니다."); }
        finally { setIsAnalyzing(false); }
    };

    // 나머지 UI 인터랙션 및 로직 (기존 코드와 100% 동일하게 유지)
    const start5Whys = async () => {
        setIsAnalyzing(true);
        try {
            const res = await callGemini(PROMPTS.ANALYSIS(perspective, deepDiveInput));
            setRootCauses(res.rootCauses); setStep(5);
        } finally { setIsAnalyzing(false); }
    };

    const exploreDeep = (id) => {
        setSelectedCauseId(id);
        const cause = rootCauses.find(c => c.id === id).realCause;
        setIsAnalyzing(true);
        callGemini(PROMPTS.HYPOTHESIS(perspective, cause))
            .then(res => { setDeepHypotheses(res.hypotheses); setStep(6); })
            .finally(() => setIsAnalyzing(false));
    };

    const generateFinal = (id) => {
        setSelectedDeepHypoId(id);
        const cause = rootCauses.find(c => c.id === selectedCauseId).realCause;
        const hypo = deepHypotheses.find(h => h.id === id).title;
        setIsAnalyzing(true);
        callGemini(PROMPTS.SUMMARY(cause, hypo))
            .then(res => { setFinalBrief(res.finalReport); setStep(7); })
            .finally(() => setIsAnalyzing(false));
    };

    const resetAll = () => { setStep(1); setRawData(""); setStep1Result(null); setStep2Result(null); };

    // [UI 렌더링 부분: 기존 코드와 동일한 클래스명 및 구조 유지]
    return (
        <div className="w-full max-w-[430px] mx-auto bg-[#f8fafc] min-h-screen relative font-sans text-slate-900 pb-10 shadow-xl">
            {isAnalyzing && (
                <div className="fixed inset-0 z-[10000] bg-white/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center max-w-[430px] mx-auto">
                    <div className="w-14 h-14 rounded-full border-4 border-slate-100 border-t-blue-600 animate-spin mb-6"></div>
                    <h3 className="text-[20px] font-black text-[#0f172a]">AI 분석 중</h3>
                    <p className="text-slate-400 mt-2 text-sm">병렬 엔진으로 가속 분석 중입니다...</p>
                </div>
            )}
            
            {step > 0 && (
                <header className="fixed top-0 left-0 right-0 z-50 glass-panel px-4 h-16 flex items-center justify-between max-w-[430px] mx-auto">
                    <div className="flex items-center gap-1 flex-1">
                        {step > 1 && <button onClick={() => setStep(s => s - 1)} className="p-2"><Icon name="ChevronLeft" size={24}/></button>}
                        <h1 className="font-bold text-[18px] text-slate-800">Step {step}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={resetAll} className="p-2"><Icon name="Home" size={20}/></button>
                    </div>
                </header>
            )}

            <main className={step === 0 ? "" : "pt-16 px-5"}>
                {step === 0 && (
                    <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-white">
                        <h1 className="font-black text-[36px] mb-4">User Voice Analysis</h1>
                        <input type="password" id="api-input" className="w-full p-4 bg-slate-50 border rounded-xl mb-4" placeholder="Gemini API Key" />
                        <button onClick={() => validateKey(document.getElementById('api-input').value)} className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold">시작하기</button>
                    </div>
                )}

                {step === 1 && (
                    <div className="py-10 animate-fade-in">
                        <h1 className="text-42px font-black mb-6">데이터를<br/>입력하세요.</h1>
                        <textarea rows={10} value={rawData} onChange={(e) => {setRawData(e.target.value); setItemCount(e.target.value.split('\n').filter(Boolean).length);}} className="w-full bg-slate-100 p-6 rounded-3xl outline-none mb-6" placeholder="리뷰 데이터를 입력하세요." />
                        <button onClick={() => runParallelAnalysis(false)} className="w-full py-5 bg-blue-600 text-white rounded-2xl font-black text-lg">분석 시작</button>
                    </div>
                )}

                {step === 2 && step1Result && (
                    <div className="animate-fade-in pb-20">
                        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white mb-8">
                            <span className="text-blue-400 font-bold block mb-2">SUMMARY</span>
                            <p className="text-lg font-light leading-relaxed">{step1Result.summary}</p>
                        </div>
                        <div className="space-y-4">
                            {step1Result.categories.map((cat, i) => (
                                <div key={i} className="bg-white p-6 rounded-[2rem] card-shadow border">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="font-bold text-xl">{cat.name}</h3>
                                        <button onClick={() => setOpinionModal({visible:true, title:cat.name, opinions:cat.opinions})} className="text-sm text-slate-400">{cat.opinions.length}건 보기</button>
                                    </div>
                                    <p className="text-slate-600 leading-relaxed">{cat.summary}</p>
                                </div>
                            ))}
                        </div>
                        <div className="fixed bottom-0 left-0 right-0 p-5 glass-panel max-w-[430px] mx-auto z-50">
                            <button onClick={() => runParallelAnalysis(true)} className="w-full py-5 bg-slate-900 text-white rounded-2xl font-black">UX/디자인 심화 분석</button>
                        </div>
                    </div>
                )}

                {step === 3 && step2Result && (
                    <div className="animate-fade-in pb-40">
                        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white mb-8">
                            <span className="text-indigo-400 font-bold block mb-2">UX SUMMARY</span>
                            <p className="text-lg font-light">{step2Result.summary}</p>
                        </div>
                        <div className="space-y-4">
                            {step2Result.uxCategories.map((cat, i) => (
                                <div key={i} className={`p-6 rounded-[2rem] border card-shadow bg-white ${selectedCategory?.name === cat.name ? 'border-indigo-500 ring-2 ring-indigo-100' : ''}`}>
                                    <div className="flex justify-between items-start mb-4">
                                        <h3 className="font-bold text-xl pr-4">{cat.name}</h3>
                                        <button onClick={() => {setSelectedCategory(cat); setDeepDiveInput(cat.summary);}} className={`px-4 py-2 rounded-xl text-sm font-bold ${selectedCategory?.name === cat.name ? 'bg-indigo-600 text-white' : 'bg-slate-100'}`}>선택</button>
                                    </div>
                                    <p className="text-slate-600 leading-relaxed">{cat.summary}</p>
                                </div>
                            ))}
                        </div>
                        <div className="fixed bottom-0 left-0 right-0 p-5 glass-panel max-w-[430px] mx-auto z-50">
                            <button onClick={() => setStep(4)} disabled={!selectedCategory} className="w-full py-5 bg-orange-500 text-white rounded-2xl font-black">5Whys 분석하기</button>
                        </div>
                    </div>
                )}

                {step === 4 && (
                    <div className="py-10 animate-fade-in">
                        <h2 className="text-28px font-black mb-6">분석 가설</h2>
                        <textarea value={deepDiveInput} onChange={(e) => setDeepDiveInput(e.target.value)} className="w-full h-64 bg-white p-6 rounded-3xl border outline-none mb-6" />
                        <button onClick={start5Whys} className="w-full py-5 bg-slate-900 text-white rounded-2xl font-black">원인 분석 시작</button>
                    </div>
                )}

                {step === 5 && rootCauses.map(rc => (
                    <div key={rc.id} className={`p-6 rounded-3xl bg-white border mb-4 card-shadow ${selectedCauseId === rc.id ? 'border-orange-500' : ''}`}>
                        <div className="flex justify-between mb-4">
                            <span className="font-bold text-orange-500">Case {rc.id}</span>
                            <button onClick={() => exploreDeep(rc.id)} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold">인사이트 도출</button>
                        </div>
                        <p className="font-bold text-lg">{rc.realCause}</p>
                    </div>
                ))}

                {step === 6 && deepHypotheses.map(h => (
                    <div key={h.id} className={`p-6 rounded-3xl bg-white border mb-4 card-shadow ${selectedDeepHypoId === h.id ? 'border-blue-500' : ''}`}>
                        <div className="flex justify-between mb-4">
                            <h3 className="font-bold text-lg">{h.title}</h3>
                            <button onClick={() => generateFinal(h.id)} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold">선택</button>
                        </div>
                        <p className="text-slate-600 text-sm">{h.step3}</p>
                    </div>
                ))}

                {step === 7 && finalBrief && (
                    <div className="animate-fade-in pb-20">
                        <div className="bg-white p-8 rounded-3xl border card-shadow mb-6">
                            <h3 className="font-bold text-xl mb-4 text-blue-600">{finalBrief.step1.title}</h3>
                            <p className="text-slate-700 leading-relaxed">{finalBrief.step1.content}</p>
                        </div>
                        <div className="bg-slate-900 p-8 rounded-3xl text-white">
                            <h3 className="font-bold text-xl mb-4 text-orange-400">전략적 해결 방향</h3>
                            <p className="leading-relaxed opacity-90">{finalBrief.step4.content}</p>
                        </div>
                    </div>
                )}
            </main>

            {opinionModal.visible && (
                <div className="fixed inset-0 z-[2000] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-[2rem] p-8 w-full max-w-[380px] max-h-[80vh] flex flex-col">
                        <div className="flex justify-between mb-6">
                            <h4 className="font-bold text-xl">{opinionModal.title}</h4>
                            <button onClick={() => setOpinionModal({visible:false, title:"", opinions:[]})}><Icon name="X"/></button>
                        </div>
                        <div className="overflow-y-auto space-y-3">
                            {opinionModal.opinions.map((op, i) => <div key={i} className="p-4 bg-slate-50 rounded-xl text-sm leading-relaxed">"{op}"</div>)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
